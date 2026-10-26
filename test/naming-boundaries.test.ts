import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extension/index.ts";
import { cleanTitle } from "../extension/naming.ts";
import { readRegistry, registryDir } from "../extension/registry.ts";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));
const reply = (title: string) => ({ content: [{ type: "text", text: JSON.stringify({ title }) }] });

function host(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "panel-naming-boundaries-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  mkdirSync(join(dir, "session-panel"));
  const config = join(dir, "session-panel", "config.json");
  writeFileSync(config, JSON.stringify({ titleModel: "p/model" }));
  const requests: { signal: AbortSignal; resolve: (reply: any) => void }[] = [];
  const hooks = new Map<string, Function>();
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "Investigate original naming topic", timestamp: Date.now() });
  const context: any = { mode: "rpc", sessionManager: manager, modelRegistry: {
    find: () => ({}), complete: (_model: any, _request: any, options: any) => new Promise(resolve => {
      requests.push({ signal: options.signal, resolve });
    }),
  } };
  const names: string[] = [];
  extension({ on: (event: string, handler: Function) => hooks.set(event, handler), registerCommand() {},
    setSessionName: (title: string) => { names.push(title); manager.appendSessionInfo(title); },
  } as any);
  t.after(() => {
    hooks.get("session_shutdown")?.({ reason: "quit" }, context);
    for (const request of requests) request.resolve(reply("Cleanup"));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  hooks.get("session_start")!({ reason: "startup" }, context);
  return { dir, config, hooks, manager, context, names, requests };
}

for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
  test(reason + " shutdown aborts naming and cannot recreate the registry", async t => {
    const h = host(t);
    h.hooks.get("session_shutdown")!({ reason }, h.context);
    assert.equal(h.requests[0].signal.aborted, true);
    h.requests[0].resolve(reply("Obsolete title"));
    await settled();
    assert.deepEqual(h.names, []);
    assert.equal(readRegistry(registryDir(h.dir)).live.length, 0);
  });
}

for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
  test(event + " releases naming immediately even when the provider ignores abort", async t => {
    const h = host(t);
    h.hooks.get(event)?.({}, h.context);
    assert.equal(h.requests[0].signal.aborted, true);
    // A cancelled navigation can be followed immediately by normal input.
    h.hooks.get("before_agent_start")!({ messageType: "user", prompt: "Continue current naming task" }, h.context);
    assert.equal(h.requests.length, 2);
    await settled(); // The old finally must not clear the new request guard.
    h.hooks.get("before_agent_start")!({ messageType: "user", prompt: "Another prompt" }, h.context);
    assert.equal(h.requests.length, 2);
    h.requests[0].resolve(reply("Obsolete title"));
    h.requests[1].resolve(reply("Current title"));
    await settled();
    assert.deepEqual(h.names, ["Current title"]);
  });
}

test("session_start replaces pending naming and tree navigation names the new branch", async t => {
  const h = host(t);
  h.hooks.get("session_start")!({ reason: "resume" }, h.context);
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.requests.length, 2);
  h.hooks.get("session_before_tree")?.({}, h.context);
  h.hooks.get("session_tree")?.({}, h.context);
  assert.equal(h.requests[1].signal.aborted, true);
  assert.equal(h.requests.length, 3);
  h.requests[0].resolve(reply("Old session"));
  h.requests[1].resolve(reply("Old branch"));
  h.requests[2].resolve(reply("Current branch"));
  await settled();
  assert.deepEqual(h.names, ["Current branch"]);
});

test("disabling or changing titleModel during generation discards its result", async t => {
  const h = host(t);
  writeFileSync(h.config, "{}");
  h.requests[0].resolve(reply("Disabled title"));
  await settled();
  assert.deepEqual(h.names, []);
  writeFileSync(h.config, JSON.stringify({ titleModel: "p/model" }));
  h.hooks.get("before_agent_start")!({ messageType: "user", prompt: "Try naming again" }, h.context);
  writeFileSync(h.config, JSON.stringify({ titleModel: "p/replacement" }));
  h.requests[1].resolve(reply("Old model title"));
  await settled();
  assert.deepEqual(h.names, []);
});

test("malformed structured replies are rejected instead of becoming permanent names", () => {
  for (const raw of ['{"title":"Truncated', '{"title":"Trailing comma",}', 'Here is JSON: {"title": invalid}', '[{"title":"Array"}]']) {
    assert.equal(cleanTitle(raw), "", raw);
  }
  assert.equal(cleanTitle('Here is JSON: {"title":"Valid name"}'), "Valid name");
  assert.equal(cleanTitle("Plain title"), "Plain title");
});

test("generated titles cannot carry terminal escapes, line controls or bidi overrides", () => {
  const esc = String.fromCharCode(27), nul = String.fromCharCode(0);
  assert.equal(cleanTitle(JSON.stringify({ title: esc + "[31mPanel" + esc + "[0m" + nul + "\nname" + String.fromCharCode(0x202e) })), "Panel name");
  const title = cleanTitle("a".repeat(59) + "😀");
  assert.equal(title.isWellFormed(), true, "length caps must not split surrogate pairs");
});
