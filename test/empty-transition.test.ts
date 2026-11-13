import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extension/index.ts";
import { createExitControl } from "../extension/exit-control.ts";
import { readRecord, removeRecord, writeRecord, registryDir } from "../extension/registry.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check()) { assert.ok(Date.now() < deadline, "panel transition must finish"); await tick(); }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function harness(t: TestContext, late = false, empty = false) {
  const dir = mkdtempSync(join(tmpdir(), "panel-closed-transition-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const file = join(dir, "target.jsonl"), registry = registryDir(dir);
  const persist = (path: string, name: string, age: number) => writeFileSync(path, [
    { type: "session", version: 3, id: name, cwd: dir, timestamp: new Date(Date.now() - age).toISOString() },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "History must retain this conversation" } },
    { type: "session_info", id: "n", parentId: "u", name },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  persist(join(dir, "older.jsonl"), "Older session", 60_000);
  if (!late) {
    persist(file, "Target session", 120_000);
    for (let i = 0; i < 40; i++) persist(join(dir, "history-" + i + ".jsonl"), "History " + i, 90_000 + i);
  }
  if (empty) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "empty", cwd: dir, timestamp: new Date().toISOString() }) + "\n");
  const controller = await createExitControl({
    target: () => ({ pid: process.pid, sessionFile: file, idle: true }),
    shutdown: () => removeRecord(registry, process.pid),
  });
  writeRecord(registry, { pid: process.pid, sessionFile: file, state: "idle", name: "Target session", cwd: dir, updatedAt: 1, exitControl: controller.registration });
  const scanned = deferred(), release = deferred();
  const list = SessionManager.listAll.bind(SessionManager);
  t.mock.method(SessionManager, "listAll", async (...args: Parameters<typeof SessionManager.listAll>) => {
    const infos = await list(...args);
    scanned.resolve();
    if (late) await release.promise;
    return infos;
  });
  const hooks = new Map<string, Function>();
  let command!: Function, component: any, finish!: () => void;
  const context: any = { mode: "tui", sessionManager: { getSessionDir: () => dir, usesDefaultSessionDir: () => false },
    ui: { custom: (factory: Function) => new Promise<void>(resolve => {
      finish = () => { component.dispose(); resolve(); };
      component = factory({ terminal: { rows: 14 }, requestRender() {} }, theme, {}, finish);
    }) },
  };
  extension({ on: (event: string, handler: Function) => hooks.set(event, handler),
    registerCommand: (_: string, options: any) => { command = options.handler; },
  } as any);
  const opened = command("", context);
  t.after(async () => {
    release.resolve();
    finish(); await opened;
    hooks.get("session_shutdown")?.();
    controller.close();
    await tick();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const screen = () => component.render(110).join("\n");
  return { file, scanned: scanned.promise, release: release.resolve, screen,
    persistTarget: () => persist(file, "Target session", 120_000),
    async exit() {
      screen();
      component.handleInput("x");
      await until(() => !readRecord(registry, process.pid) && !screen().includes("exit…"));
    },
  };
}

test("Idle x deletes a metadata-only session without adding it to Closed", async t => {
  const h = await harness(t, false, true);
  await h.scanned;
  await until(() => h.screen().includes("41 closed"));
  await h.exit();
  assert.equal(existsSync(h.file), false);
  assert.match(h.screen(), /0 live · 41 closed/);
  assert.doesNotMatch(h.screen(), /Target session|new session/);
});

test("Idle x on an unpersisted session does not create a phantom Closed row", async t => {
  const h = await harness(t, true);
  await h.scanned;
  await h.exit();
  h.release();
  await until(() => h.screen().includes("Older session"));
  assert.match(h.screen(), /0 live · 1 closed/);
  assert.doesNotMatch(h.screen(), /Target session|new session/);
});
