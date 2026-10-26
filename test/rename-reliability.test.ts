import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extension/index.ts";
import { createNamer, generateSessionTitle, nameSource, capInput, cleanTitle } from "../extension/naming.ts";
import { readRegistry, registryDir, writeRecord } from "../extension/registry.ts";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));
const reply = (title: string) => ({ content: [{ type: "text", text: JSON.stringify({ title }) }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function host(t: any, complete: any, name?: string, model?: string) {
  const dir = mkdtempSync(join(tmpdir(), "panel-naming-reliability-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  mkdirSync(join(dir, "session-panel"), { recursive: true });
  const config = join(dir, "session-panel", "config.json");
  writeFileSync(config, JSON.stringify(model ? { titleModel: model } : {}));
  const file = join(dir, "session.jsonl");
  const entries: any[] = [
    { type: "session", version: 3, id: "rename-review", timestamp: new Date().toISOString(), cwd: dir },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "Investigate selected session naming" } },
  ];
  if (name) entries.push({ type: "session_info", id: "n", parentId: "u", name });
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const manager = SessionManager.open(file);
  const hooks = new Map<string, Function>();
  const context: any = { hasUI: false, mode: "rpc", sessionManager: manager,
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), complete } };
  extension({ on: (event: string, handler: Function) => hooks.set(event, handler), registerCommand() {},
    setSessionName: (title: string) => manager.appendSessionInfo(title),
  } as any);
  t.after(() => {
    hooks.get("session_shutdown")?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const registered = () => readRegistry(registryDir(dir)).live.find(row => row.pid === process.pid)!;
  const externalRename = (title: string) => {
    SessionManager.open(file).appendSessionInfo(title);
    writeRecord(registryDir(dir), { ...registered(), name: title });
  };
  hooks.get("session_start")!({}, context);
  return { dir, config, file, manager, hooks, context, registered, externalRename };
}

test("an external manual name wins over an automatic request already in flight", async t => {
  const request = deferred<any>();
  const h = host(t, () => request.promise, undefined, "p/model");
  h.externalRename("User chosen name");
  request.resolve(reply("Automatic name"));
  await settled();
  assert.equal(h.manager.getSessionName(), "User chosen name");
  assert.equal(SessionManager.open(h.file).getSessionName(), "User chosen name");
  assert.equal(h.registered().name, "User chosen name");
});

test("an external rename during Working survives agent_settled and the next turn", t => {
  const h = host(t, () => assert.fail("named sessions must not call the model"), "Old name");
  h.hooks.get("agent_start")!();
  h.externalRename("User chosen name");
  h.hooks.get("agent_settled")!();
  assert.equal(h.registered().state, "idle");
  assert.equal(h.registered().name, "User chosen name");
  assert.equal(h.manager.getSessionName(), "User chosen name");
  h.hooks.get("agent_start")!();
  assert.equal(h.registered().name, "User chosen name");
  assert.equal(SessionManager.open(h.file).getSessionName(), "User chosen name");
});

test("automatic retries use the updated titleModel and respect disabling it", async t => {
  const models: string[] = [];
  const h = host(t, async (model: any) => { models.push(model.id); throw new Error("offline fixture"); }, undefined, "p/old");
  await settled();
  writeFileSync(h.config, '{"titleModel":"p/new"}');
  h.hooks.get("before_agent_start")!({ messageType: "user", prompt: "Try the current model" }, h.context);
  await settled();
  writeFileSync(h.config, '{}');
  h.hooks.get("before_agent_start")!({ messageType: "user", prompt: "Naming disabled now" }, h.context);
  await settled();
  assert.deepEqual(models, ["old", "new"]);
});

test("invalid JSON title fields fail without writing and automatic naming can retry", async t => {
  for (const raw of ['{"title":null}', '{"title":7}', '{"title":" "}', '{"error":"rate limited"}']) {
    assert.equal(cleanTitle(raw), "", raw);
  }
  assert.equal(cleanTitle("A plain text name"), "A plain text name");
  let calls = 0;
  const h = host(t, async () => ++calls === 1 ? { content: [{ type: "text", text: '{"title":null}' }] } : reply("Valid name"), undefined, "p/model");
  await settled();
  assert.equal(h.manager.getSessionName(), undefined);
  h.hooks.get("before_agent_start")!({ messageType: "user", prompt: "Retry with a valid title" }, h.context);
  await settled();
  assert.equal(h.manager.getSessionName(), "Valid name");
});

test("automatic timeout releases its guard even if a provider ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stale = deferred<any>();
  let calls = 0, signal!: AbortSignal;
  const names: string[] = [];
  const context: any = { sessionManager: { getSessionName: () => undefined, getBranch: () => [
    { type: "message", message: { role: "user", content: "Investigate selected session naming" } },
  ] }, modelRegistry: { find: () => ({}), complete: (_model: any, _request: any, options: any) => {
    calls++; signal = options?.signal;
    return calls === 1 ? stale.promise : Promise.resolve(reply("Retry name"));
  } } };
  const namer = createNamer({ pi: { setSessionName: (name: string) => names.push(name) } as any, model: () => "p/model" });
  const pending = namer(context);
  t.mock.timers.tick(30_000);
  // A real timeout keeps this assertion from hanging on the pre-fix renderer.
  assert.ok(signal?.aborted, "the shared deadline must abort the request");
  await pending;
  await namer(context);
  stale.resolve(reply("Late obsolete name"));
  await settled();
  assert.equal(calls, 2);
  assert.deepEqual(names, ["Retry name"]);
});

test("manual cancellation and timeout reject even when the provider never settles", async t => {
  const h = host(t, () => new Promise(() => {}), "Old name");
  const controller = new AbortController();
  const cancelled = generateSessionTitle(h.context, h.file, "p/model", controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /aborted/);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timedOut = generateSessionTitle(h.context, h.file, "p/model");
  t.mock.timers.tick(30_000);
  await assert.rejects(timedOut, /timed out/i);
  assert.equal(SessionManager.open(h.file).getSessionName(), "Old name");
});

test("automatic model context preserves the task head and latest ask within its budget", async () => {
  const initial = "SpecificSubject original task " + "long pasted log ".repeat(500);
  const latest = "Latest question about that task";
  const source = nameSource([{ type: "message", message: { role: "user", content: initial } }], latest)!;
  assert.ok(source.startsWith("SpecificSubject original task"));
  assert.ok(source.endsWith(latest));
  assert.equal(source.length, 1000);
  assert.match(source, /characters omitted/);
  let captured = "";
  await createNamer({ pi: { setSessionName() {} } as any, model: () => "p/model" })({
    sessionManager: { getSessionName: () => undefined, getBranch: () => [{ type: "message", message: { role: "user", content: initial } }] },
    modelRegistry: { find: () => ({}), complete: async (_model: any, request: any, options: any) => {
      captured = request.messages[0].content;
      assert.ok(options.maxTokens > 0 && options.maxTokens <= 512);
      return reply("Task name");
    } },
  } as any, latest);
  assert.ok(captured.includes(source));
  assert.equal(capInput("short"), "short");
});

test("manual generation rejects invalid JSON and truncated output without changing the name", async t => {
  let response: any = { content: [{ type: "text", text: '{"error":"rate limited"}' }] };
  const h = host(t, async () => response, "User name");
  await assert.rejects(generateSessionTitle(h.context, h.file, "p/model"), /no title/);
  response = { ...reply("Partial title"), stopReason: "length" };
  await assert.rejects(generateSessionTitle(h.context, h.file, "p/model"), /output budget/);
  assert.equal(SessionManager.open(h.file).getSessionName(), "User name");
});

test("successful generation removes its timeout and manual cancellation listener", async t => {
  const h = host(t, async () => reply("Draft name"), "Old name");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let requestSignal!: AbortSignal;
  h.context.modelRegistry.complete = async (_model: any, _request: any, options: any) => {
    requestSignal = options.signal;
    return reply("Draft name");
  };
  assert.equal(await generateSessionTitle(h.context, h.file, "p/model", controller.signal), "Draft name");
  t.mock.timers.tick(30_000);
  controller.abort();
  assert.equal(requestSignal.aborted, false, "completed requests have no remaining deadline or cancel listener");
});
