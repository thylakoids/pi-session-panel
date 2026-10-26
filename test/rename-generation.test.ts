import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSessionTitle, createNamer, capInput, RENAME_CONTENT_LIMIT } from "../extension/naming.ts";
import { SessionsPanel } from "../extension/panel.ts";
import extension from "../extension/index.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readRegistry, registryDir, writeRecord } from "../extension/registry.ts";

const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text };
function session(t: any, prompts: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "panel-rename-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  const entries = prompts.map((text, index) => ({ type: "message", id: `u${index}`, parentId: index ? `u${index - 1}` : null,
    message: { role: "user", content: [{ type: "text", text }] } }));
  writeFileSync(file, [
    { type: "session", version: 3, id: "selected", timestamp: new Date().toISOString(), cwd: dir },
    ...entries,
    { type: "message", id: "hidden", parentId: "u0", message: { role: "user", content: "OFF-BRANCH TOPIC" } },
    { type: "message", id: "assistant", parentId: entries.at(-1)!.id, message: { role: "assistant", content: [{ type: "text", text: "ASSISTANT TOPIC" }] } },
    { type: "session_info", id: "name", parentId: "assistant", name: "Old name" },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  return { file, entries };
}

test("manual rename uses all selected-branch user prompts with the automatic model API and title rules", async t => {
  const { file, entries } = session(t, ["EARLY SUBJECT " + "x".repeat(1500), "LATEST SUBJECT"]);
  const original = readFileSync(file, "utf8");
  const requests: any[] = [];
  const model = { id: "cheap", provider: "p" };
  const ctx: any = { sessionManager: { getSessionName: () => undefined, getBranch: () => entries }, modelRegistry: {
    find: (provider: string, id: string) => provider === "p" && id === "cheap" ? model : undefined,
    complete: async (selected: any, request: any, options: any) => {
      assert.equal(selected, model); requests.push({ request, options });
      return { content: [{ type: "text", text: '{"title":"Panel naming"}' }] };
    },
  } };
  const controller = new AbortController();
  assert.equal(await generateSessionTitle(ctx, file, "p/cheap", controller.signal), "Panel naming");
  const prompt = requests[0].request.messages[0].content;
  assert.ok(prompt.includes(entries[0].message.content[0].text));
  assert.ok(prompt.includes("LATEST SUBJECT"));
  assert.doesNotMatch(prompt, /OFF-BRANCH|ASSISTANT TOPIC/);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(requests[0].options.signal.aborted, false);
  assert.equal(requests[0].options.maxTokens, 512);
  assert.equal(readFileSync(file, "utf8"), original, "generation must not write session_info");
  await createNamer({ pi: { setSessionName() {} } as any, model: () => "p/cheap" })(ctx);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].request.systemPrompt, requests[1].request.systemPrompt);
});

test("manual rename shares head-and-tail truncation with the larger budget", async t => {
  const prompts = ["OLD ".repeat(5000), "RECENT " + "z".repeat(2500), "NEWEST QUESTION"];
  const { file } = session(t, prompts);
  let text = "";
  await generateSessionTitle({ modelRegistry: { find: () => ({}), complete: async (_model: any, request: any) => {
    text = request.messages[0].content; return { content: [{ type: "text", text: '{"title":"New topic"}' }] };
  } } } as any, file, "p/model");
  const content = text.slice("<session>\n".length, text.indexOf("\n</session>"));
  assert.equal(content, capInput(prompts.join("\n"), RENAME_CONTENT_LIMIT).trim());
  assert.ok(content.endsWith("NEWEST QUESTION"));
  assert.ok(content.includes(prompts[1]));
});

test("manual generation reports configuration and provider failures without writing", async t => {
  const { file } = session(t, ["A selected session topic"]);
  const original = readFileSync(file, "utf8");
  const ctx: any = { modelRegistry: { find: () => undefined, complete: () => assert.fail("must not call an unknown model") } };
  await assert.rejects(generateSessionTitle(ctx, file, undefined), /Configure titleModel/);
  await assert.rejects(generateSessionTitle(ctx, file, "p/unknown"), /no model/);
  ctx.modelRegistry.find = () => ({});
  ctx.modelRegistry.complete = async () => ({ stopReason: "error", errorMessage: "provider denied", content: [{ type: "text", text: "not a title" }] });
  await assert.rejects(generateSessionTitle(ctx, file, "p/model"), /provider denied/);
  ctx.modelRegistry.complete = async () => ({ content: [] });
  await assert.rejects(generateSessionTitle(ctx, file, "p/model"), /no title/);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("a session without user text cannot spend a naming call", async t => {
  const { file } = session(t, [""]);
  await assert.rejects(generateSessionTitle({ modelRegistry: {
    find: () => ({}), complete: () => assert.fail("assistant text is not naming context"),
  } } as any, file, "p/model"), /no user prompts/);
});

test("cancelling the provider request discards its late title without writing", async t => {
  const { file } = session(t, ["Selected session naming"]);
  const original = readFileSync(file, "utf8");
  const controller = new AbortController();
  let deliver!: (value: any) => void;
  const pending = generateSessionTitle({ modelRegistry: {
    find: () => ({}), complete: async (_model: any, _request: any, options: any) => {
      assert.ok(options.signal instanceof AbortSignal);
      return new Promise(resolve => { deliver = resolve; });
    },
  } } as any, file, "p/model", controller.signal);
  controller.abort();
  deliver({ content: [{ type: "text", text: '{"title":"Late result"}' }] });
  await assert.rejects(pending, /aborted/);
  assert.equal(readFileSync(file, "utf8"), original);
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
function editor(generateName: (row: any, signal: AbortSignal) => Promise<string>) {
  const saved: string[] = [];
  const row = { key: "selected", state: "closed" as const, name: "Old name", cwd: "/tmp", sessionFile: "/tmp/selected.jsonl", updatedAt: 1 };
  const view = new SessionsPanel({ rows: () => [row], close() {}, actions: {
    generateName, rename: (_row, name) => { saved.push(name); }, focus() {}, interrupt() {}, exit() {}, remove() {}, reopen() {}, rescan() {},
  } });
  view.render(theme, 80, 12);
  return { view, saved };
}

test("Rename Ctrl+G generates one editable draft; only Enter saves it", async () => {
  const reply = deferred<string>(); let calls = 0;
  const { view, saved } = editor(async row => { assert.equal(row.key, "selected"); calls++; return reply.promise; });
  await view.handleInput("r");
  assert.match(view.render(theme, 80, 12).join("\n"), /ctrl\+g generate/);
  await view.handleInput("\x07"); await view.handleInput("\x07");
  assert.equal(calls, 1);
  assert.match(view.render(theme, 80, 12).join("\n"), /Generating name/);
  reply.resolve("Generated title"); await settled();
  assert.deepEqual(saved, []);
  assert.match(view.render(theme, 80, 12).join("\n"), /Generated title/);
  await view.handleInput("!"); await view.handleInput("\r");
  assert.deepEqual(saved, ["Generated title!"]);
});

test("Esc aborts generation and late results cannot overwrite a reopened rename draft", async () => {
  const reply = deferred<string>(); let signal!: AbortSignal;
  const { view, saved } = editor(async (_row, input) => { signal = input; return reply.promise; });
  await view.handleInput("r"); await view.handleInput("\x07"); await view.handleInput("\x1b");
  assert.equal(signal.aborted, true);
  await view.handleInput("r");
  reply.resolve("Late title"); await settled();
  assert.deepEqual(saved, []);
  assert.doesNotMatch(view.render(theme, 80, 12).join("\n"), /Late title/);
  assert.match(view.render(theme, 80, 12).join("\n"), /Old name/);
});

test("generation failure preserves the manual draft, and disposing aborts an in-flight request", async () => {
  const reply = deferred<string>(); let signal!: AbortSignal;
  const { view, saved } = editor(async (_row, input) => { signal = input; return reply.promise; });
  await view.handleInput("r"); await view.handleInput("X"); await view.handleInput("\x07");
  reply.reject(new Error("API unavailable")); await settled();
  assert.match(view.errorText()!, /API unavailable/);
  assert.match(view.render(theme, 80, 12).join("\n"), /Old nameX/);
  assert.deepEqual(saved, []);
  const next = editor(async (_row, input) => { signal = input; return new Promise(() => {}); });
  await next.view.handleInput("r"); await next.view.handleInput("\x07"); next.view.dispose();
  assert.equal(signal.aborted, true);
});

test("saving the current session rename updates Pi's in-memory name and survives the next turn", async t => {
  const { file } = session(t, ["Current session naming"]);
  const agentDir = join(file, "..", "agent");
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalDir; });
  const manager = SessionManager.open(file);
  const hooks = new Map<string, Function>();
  const commands = new Map<string, any>();
  let component: any;
  const context: any = { mode: "tui", sessionManager: manager, ui: {
    setEditorComponent() {}, notify() {},
    async custom(factory: any) {
      component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, {}, () => {});
      component.render(80);
      component.handleInput("r"); component.handleInput("X"); component.handleInput("\r");
      await settled();
      component.dispose();
    },
  } };
  extension({
    on: (event: string, handler: Function) => hooks.set(event, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    setSessionName: (title: string) => { manager.appendSessionInfo(title); },
  } as any);
  t.after(() => { component?.dispose(); hooks.get("session_shutdown")?.(); });
  hooks.get("session_start")!({}, context);
  await commands.get("sessions").handler("", context);
  assert.equal(manager.getSessionName(), "Old nameX", "do not only append through a second SessionManager");
  assert.equal(SessionManager.open(file).getSessionName(), "Old nameX");
  hooks.get("agent_start")!();
  assert.equal(readRegistry(registryDir(agentDir)).live.find(row => row.pid === process.pid)!.name, "Old nameX");
  // Another live panel writes the file and this process's registry record.
  SessionManager.open(file).appendSessionInfo("Renamed from another panel");
  const own = readRegistry(registryDir(agentDir)).live.find(row => row.pid === process.pid)!;
  writeRecord(registryDir(agentDir), { ...own, name: "Renamed from another panel" });
  hooks.get("agent_start")!();
  assert.equal(manager.getSessionName(), "Renamed from another panel");
  assert.equal(readRegistry(registryDir(agentDir)).live.find(row => row.pid === process.pid)!.name, "Renamed from another panel");
});
