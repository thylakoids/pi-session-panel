import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extension/index.ts";
import { SessionsPanel } from "../extension/panel.ts";
import { insertClosed, scanClosed } from "../extension/closed.ts";
import { readClosedCache, writeClosedCache } from "../extension/closed-cache.ts";
import { readRecord } from "../extension/registry.ts";
import { rowFromRecord } from "../extension/live.ts";
import type { SessionRow } from "../extension/types.ts";

const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
const noop = () => {};
const actions = { focus: noop, reopen: noop, interrupt: noop, exit: noop, remove: noop, rename: noop, rescan: noop };
const row = (key: string): SessionRow => ({ key, state: "closed", name: key, cwd: "/tmp", updatedAt: 100 });
const panel = (rows: SessionRow[]) => new SessionsPanel({ rows: () => [...rows], actions, close: noop });
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "panel-refresh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "refresh", timestamp: new Date().toISOString(), cwd: dir }) + "\n");
  return { dir, file };
}

test("unchanged polls reuse the projection and frame even when rows() returns fresh arrays", t => {
  t.mock.method(Date, "now", () => 123456);
  const view = panel(Array.from({ length: 2000 }, (_, i) => row("row-" + i)));
  const lines = view.render(theme, 100, 20), nodes = view.nodes();
  for (let i = 0; i < 5; i++) {
    assert.equal(view.needsRedraw(theme, 100, 20), false);
    assert.equal(view.render(theme, 100, 20), lines);
    assert.ok(view.nodes() === nodes, "unchanged data must reuse the node projection");
  }
});

test("an external equal-length rename beyond row 300 immediately invalidates the frame", async t => {
  t.mock.method(Date, "now", () => 123456);
  const rows = Array.from({ length: 400 }, (_, i) => row("row-" + i));
  const view = panel(rows);
  view.render(theme, 100, 20);
  await view.handleInput("G");
  view.render(theme, 100, 20);
  rows[399]!.name = "new-399";
  assert.equal(view.needsRedraw(theme, 100, 20), true);
  assert.match(view.render(theme, 100, 20).join("\n"), /new-399/);
  assert.equal(view.needsRedraw(theme, 100, 20), false);
});

test("search content and action credentials refresh without an activity timestamp change", async t => {
  t.mock.method(Date, "now", () => 123456);
  const rows = [{ ...row("live:1"), state: "idle" as const, searchText: "old subject", exitControl: { endpoint: "/socket", token: "old" } }];
  let token = "";
  const view = new SessionsPanel({ rows: () => rows, close: noop, actions: {
    ...actions, exit: selected => { token = selected.exitControl!.token; },
  } });
  view.render(theme, 100, 20);
  await view.handleInput("/");
  await view.handleInput("new");
  assert.match(view.render(theme, 100, 20).join("\n"), /No session matches/);
  rows[0]!.searchText = "new subject";
  rows[0]!.exitControl.token = "new";
  assert.equal(view.needsRedraw(theme, 100, 20), true);
  assert.match(view.render(theme, 100, 20).join("\n"), /live:1/);
  await view.handleInput("\x1b");
  await view.handleInput("x");
  assert.equal(token, "new");
});

test("theme replacement and explicit invalidation rebuild cached colors", t => {
  t.mock.method(Date, "now", () => 123456);
  const view = panel([row("one")]);
  const first = view.render(theme, 100, 20);
  const replacement = { ...theme, fg: (_: string, s: string) => "\x1b[31m" + s + "\x1b[0m" };
  assert.equal(view.needsRedraw(replacement, 100, 20), true);
  assert.notDeepEqual(view.render(replacement, 100, 20), first);
  view.invalidate();
  assert.equal(view.needsRedraw(replacement, 100, 20), true);
});

test("a failed dirty-directory scan preserves cached rows and old stamps for retry", async t => {
  const { dir, file } = fixture(t);
  appendFileSync(file, JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "Retained history" } }) + "\n");
  const before = await scanClosed(dir);
  appendFileSync(file, JSON.stringify({ type: "session_info", name: "Updated" }) + "\n");
  const mock = t.mock.method(SessionManager, "listAll", async () => { throw new Error("temporary failure"); });
  const failed = await scanClosed(dir, before.cache);
  assert.deepEqual(failed, before);
  mock.mock.restore();
  const retried = await scanClosed(dir, failed.cache);
  assert.equal(retried.rows[0]!.name, "Updated");
  assert.notEqual(retried.cache[0]!.stamp, before.cache[0]!.stamp);
});

test("cancellation during history parsing rejects instead of publishing a partial index", async t => {
  const { dir } = fixture(t);
  const controller = new AbortController();
  t.mock.method(SessionManager, "listAll", async () => { controller.abort(); throw controller.signal.reason; });
  await assert.rejects(scanClosed(dir, [], controller.signal), { name: "AbortError" });
});

test("malformed cache rows and registry fields cannot enter the renderer", t => {
  const { dir } = fixture(t);
  const path = join(dir, "cache.json");
  assert.equal(readClosedCache(path), null);
  for (const raw of ["{ broken JSON", JSON.stringify({ version: 999, rows: [] })]) {
    writeFileSync(path, raw);
    assert.equal(readClosedCache(path), null);
  }
  for (const entry of [null, {}, { stamp: "1:1", row: { ...row("a"), name: 12 } }]) {
    writeFileSync(path, JSON.stringify({ version: 1, rows: [entry] }));
    assert.equal(readClosedCache(path), null);
  }
  const valid = { row: row("a"), stamp: "1:1" };
  writeClosedCache(path, [valid]);
  assert.deepEqual(readClosedCache(path)!.rows, [valid]);
  const recordDir = join(dir, String(process.pid));
  mkdirSync(recordDir);
  for (const invalid of [{ name: 12 }, { cwd: null }, { state: "closed" }, { exitControl: {} }]) {
    writeFileSync(join(recordDir, "record.json"), JSON.stringify({ pid: process.pid, cwd: dir, state: "idle", updatedAt: 1, ...invalid }));
    assert.equal(readRecord(dir, process.pid), undefined);
  }
});

test("unnamed live sessions accept whitespace in serialized user messages", t => {
  const { file } = fixture(t);
  appendFileSync(file, '{"type":"message","message":{"role": "user", "content": "first task"}}\n');
  assert.equal(rowFromRecord({ pid: process.pid, cwd: "/tmp", state: "idle", updatedAt: 1, sessionFile: file }).name, "first task");
});

test("custom session directories ignore the global cache and closing clears the poll timer", async t => {
  const { dir } = fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const hooks = new Map<string, Function>();
  let command!: Function;
  let component: any;
  const timer = { unref() {} };
  t.mock.method(globalThis, "setInterval", () => timer as any);
  const clear = t.mock.method(globalThis, "clearInterval", noop);
  t.after(() => {
    hooks.get("session_shutdown")?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const cache = join(dir, "session-panel", "closed-cache.json");
  writeClosedCache(cache, [{ row: row("foreign-global-session"), stamp: "1:1" }]);
  extension({ on: (event: string, handler: Function) => hooks.set(event, handler),
    registerCommand: (_: string, options: any) => { command = options.handler; },
  } as any);
  const context = { mode: "tui", sessionManager: { getSessionDir: () => dir, usesDefaultSessionDir: () => false },
    ui: { custom: (factory: Function) => new Promise(resolve => {
      component = factory({ requestRender: noop, terminal: { rows: 40 } }, theme, {}, resolve);
    }) },
  };
  const opened = command("", context);
  assert.doesNotMatch(component.render(100).join("\n"), /foreign-global-session/);
  const first = component.render(100);
  component.invalidate();
  assert.notEqual(component.render(100), first);
  component.handleInput("q");
  await opened;
  assert.equal(clear.mock.calls[0]!.arguments[0], timer);
});

test("closing an indexed live session replaces its stale history row and moves it to the front", () => {
  const stale = { ...row("closed:target"), name: "Old title", updatedAt: 1, searchText: "full conversation", sessionId: "target" };
  const recent = { ...row("closed:recent"), updatedAt: 50 };
  const closed = { ...row("closed:target"), name: "Current title", updatedAt: 100 };
  const next = insertClosed({ rows: [recent, stale], loadedAt: 1 }, closed);
  assert.deepEqual(next.rows.map(r => r.key), ["closed:target", "closed:recent"]);
  assert.equal(next.rows[0]!.name, "Current title");
  assert.equal(next.rows[0]!.searchText, "full conversation");
  assert.equal(next.rows[0]!.sessionId, "target");
  assert.equal(next.rows[0]!.updatedAt, 100);
});
