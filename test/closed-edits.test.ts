import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extension/index.ts";
import { scanClosed } from "../extension/closed.ts";
import { readClosedCache, writeClosedCache } from "../extension/closed-cache.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check()) { assert.ok(Date.now() < deadline, "history edit must settle"); await tick(); }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function harness(t: TestContext, named = true) {
  const dir = mkdtempSync(join(tmpdir(), "panel-closed-edits-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const file = join(dir, "session.jsonl");
  writeFileSync(file, [
    { type: "session", version: 3, id: "edit-session", timestamp: new Date().toISOString(), cwd: dir },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "Persistent conversation text" } },
    { type: "session_info", id: "n", parentId: "u", name: named ? "Stale title" : undefined },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const initial = await scanClosed(dir);
  const cache = join(dir, "session-panel", "closed-cache-" + createHash("sha256").update(dir).digest("hex").slice(0, 16) + ".json");
  writeClosedCache(cache, initial.cache);
  writeFileSync(cache, JSON.stringify({ ...readClosedCache(cache), savedAt: 0 }));
  appendFileSync(file, "\n"); // Force parsing while the first frame uses cached rows.
  const captured = deferred(), release = deferred();
  const list = SessionManager.listAll.bind(SessionManager);
  t.mock.method(SessionManager, "listAll", async (...args: Parameters<typeof SessionManager.listAll>) => {
    const infos = await list(...args);
    captured.resolve(); await release.promise;
    return infos;
  });
  const hooks = new Map<string, Function>();
  let command!: Function, component: any, finish!: () => void;
  extension({ on: (event: string, handler: Function) => hooks.set(event, handler), registerCommand: (_: string, options: any) => { command = options.handler; } } as any);
  const opened = command("", { mode: "tui", sessionManager: { getSessionDir: () => dir, usesDefaultSessionDir: () => false },
    ui: { custom: (factory: Function) => new Promise(resolve => {
      finish = () => { component.dispose(); resolve(); };
      component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, finish);
    }) },
  });
  t.after(async () => {
    release.resolve(); finish(); await opened;
    hooks.get("session_shutdown")?.();
    await tick();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const screen = () => component.render(110).join("\n");
  screen(); await captured.promise;
  return { file, screen, release: release.resolve, input: (data: string) => component.handleInput(data),
    async scanFinished() { await until(() => Boolean(readClosedCache(cache)?.savedAt)); },
    cache: () => readClosedCache(cache),
  };
}

test("a cached history rename survives an older background scan and updates search immediately", async t => {
  const h = await harness(t);
  h.input("r"); h.input("\x15"); h.input("Fresh title"); h.input("\r");
  await until(() => h.screen().includes("Fresh title") && !/enter save|save…/.test(h.screen()));
  h.release(); await h.scanFinished();
  assert.match(h.screen(), /Fresh title/);
  assert.doesNotMatch(h.screen(), /Stale title/);
  assert.equal(h.cache()!.rows[0]!.row.name, "Fresh title");
  h.input("/"); h.input('"Fresh title"');
  assert.match(h.screen(), /Fresh title/);
  assert.doesNotMatch(h.screen(), /No session matches/);
  h.input("\x1b"); h.input("/"); h.input('"Stale title"');
  assert.match(h.screen(), /No session matches/);
});

test("deletion during a background scan cannot resurrect the cached row", async t => {
  const h = await harness(t);
  h.input("x"); await tick(); h.input("x");
  await until(() => !existsSync(h.file) && h.screen().includes("No sessions"));
  h.release(); await h.scanFinished();
  assert.match(h.screen(), /0 live · 0 closed/);
  assert.equal(h.cache()!.rows.length, 0);
  assert.doesNotMatch(h.screen(), /Stale title/);
});

test("repeated renames of an initially unnamed session replace only the title in search", async t => {
  const h = await harness(t, false);
  for (const name of ["Fresh title", "Final title"]) {
    h.input("r"); h.input("\x15"); h.input(name); h.input("\r");
    await until(() => h.screen().includes(name) && !/enter save|save…/.test(h.screen()));
    await tick();
  }
  h.release(); await h.scanFinished();
  h.input("/"); h.input('"Fresh title"');
  assert.match(h.screen(), /No session matches/);
  h.input("\x1b"); h.input("/"); h.input('"Final title"');
  assert.doesNotMatch(h.screen(), /No session matches/);
  h.input("\x1b"); h.input("/"); h.input('"Persistent conversation text"');
  assert.doesNotMatch(h.screen(), /No session matches/, "the original user message remains searchable");
});
