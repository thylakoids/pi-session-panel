import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extension/index.ts";
import { createRowsSource, rowFromRecord } from "../extension/live.ts";
import { SessionsPanel } from "../extension/panel.ts";
import { registryDir, writeRecord } from "../extension/registry.ts";
import type { SessionRow } from "../extension/types.ts";

const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
const noop = () => {};
const actions = { focus: noop, reopen: noop, interrupt: noop, exit: noop, remove: noop, rename: noop, rescan: noop };
const row = (key: string): SessionRow => ({ key, state: "closed", name: key, cwd: "/tmp", updatedAt: 1 });

test("a versioned snapshot avoids reading or traversing history on cursor movement", async t => {
  t.mock.method(Date, "now", () => 123456);
  const rows = Array.from({ length: 2000 }, (_, i) => row("session-" + i));
  let reads = 0, version = 0;
  const view = new SessionsPanel({ rows: () => { reads++; return rows; }, rowsVersion: () => version, actions, close: noop });
  view.render(theme, 100, 20);
  for (let i = 0; i < 10; i++) {
    await view.handleInput("j");
    view.render(theme, 100, 20);
    assert.equal(view.needsRedraw(theme, 100, 20), false);
  }
  assert.equal(reads, 1);
  rows[10]!.name = "Externally renamed";
  version++;
  assert.equal(view.needsRedraw(theme, 100, 20), true);
  assert.match(view.render(theme, 100, 20).join("\n"), /Externally renamed/);
  assert.equal(reads, 2);
});

test("the source only advances for changes and snapshots exit credentials", () => {
  const live = { pid: 1, state: "idle" as const, cwd: "/tmp", name: "Live", updatedAt: 1,
    sessionFile: "/live.jsonl", exitControl: { endpoint: "/socket", token: "old" } };
  let closed = [row("history"), { ...row("closed:/live.jsonl"), sessionFile: live.sessionFile }];
  const source = createRowsSource(() => [live], () => closed);
  source.refresh();
  const first = source.rows, version = source.version;
  source.refresh();
  assert.equal(source.rows, first);
  assert.equal(source.version, version);
  assert.equal(source.rows.length, 2, "the indexed live file stays hidden");
  assert.equal(source.rows[1]!.key, "history", "only the non-running history row remains");
  live.exitControl.token = "new";
  source.refresh();
  assert.equal(first[0]!.exitControl!.token, "old");
  assert.equal(source.rows[0]!.exitControl!.token, "new");
  assert.ok(source.version > version);
  closed = [row("new history"), ...closed];
  source.refresh();
  assert.equal(source.rows[1]!.key, "new history");
});

test("a nameless live record can acquire a first-message label without a registry change", t => {
  const dir = fs.mkdtempSync(join(tmpdir(), "panel-snapshot-label-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  fs.writeFileSync(file, '{"type":"session"}\n');
  const record = { pid: 1, state: "working" as const, cwd: dir, updatedAt: 1, sessionFile: file };
  assert.equal(rowFromRecord({ ...record, sessionFile: undefined }).name, "(new session)");
  const source = createRowsSource(() => [record], () => undefined);
  source.refresh();
  assert.equal(source.rows[0]!.name, "(new session)");
  fs.appendFileSync(file, '{"type":"message","message":{"role":"user","content":"First task"}}\n');
  source.refresh();
  assert.equal(source.rows[0]!.name, "First task");
});

test("production editing and rendering perform no registry scans between poll ticks", async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), "panel-snapshot-host-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const registry = registryDir(dir);
  writeRecord(registry, { pid: process.pid, state: "idle", name: "Snapshot target", cwd: dir, updatedAt: 1 });
  const hooks = new Map<string, Function>();
  let command!: Function, component: any, poll!: () => void;
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { poll = callback; return {} as any; });
  t.mock.method(globalThis, "clearInterval", noop);
  let scans = 0;
  const original = fs.readdirSync;
  const mock = t.mock.method(fs, "readdirSync", ((path: any, ...args: any[]) => {
    if (path === registry) scans++;
    return (original as any)(path, ...args);
  }) as typeof fs.readdirSync);
  syncBuiltinESMExports();
  t.after(async () => {
    hooks.get("session_shutdown")?.();
    mock.mock.restore(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await new Promise(resolve => setImmediate(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  extension({ on: (name: string, handler: Function) => hooks.set(name, handler), registerCommand: (_: string, options: any) => { command = options.handler; } } as any);
  const context = { mode: "tui", sessionManager: { getSessionDir: () => join(dir, "sessions"), usesDefaultSessionDir: () => false },
    ui: { custom: (factory: Function) => new Promise(resolve => {
      component = factory({ terminal: { rows: 30 }, requestRender: noop }, theme, {}, resolve);
    }) },
  };
  const opened = command("", context);
  const initialScans = scans;
  for (const key of ["/", "S", "n", "a", "p", "\x1b", "j", "k"]) {
    component.handleInput(key);
    component.render(100);
  }
  assert.equal(scans, initialScans, "keystrokes must only consume the snapshot");
  writeRecord(registry, { pid: process.pid, state: "idle", name: "Updated target", cwd: dir, updatedAt: 2 });
  poll();
  assert.equal(scans, initialScans + 1);
  assert.match(component.render(100).join("\n"), /Updated target/);
  component.handleInput("q");
  await opened;
});

test("unrecognized keys and hidden animations do not invalidate a cached frame", async t => {
  let at = 0;
  t.mock.method(Date, "now", () => at);
  const rows = [{ ...row("worker"), state: "working" as const, workingSince: 0 }, ...Array.from({ length: 40 }, (_, i) => row("history-" + i))];
  const view = new SessionsPanel({ rows: () => rows, actions, close: noop });
  view.render(theme, 100, 10);
  await view.handleInput("G");
  const lines = view.render(theme, 100, 10);
  await view.handleInput("z");
  assert.equal(view.render(theme, 100, 10), lines);
  at = 300;
  assert.equal(view.needsRedraw(theme, 100, 10), false, "an offscreen spinner must not drive redraws");
});

test("help remains still while worker clocks advance", async t => {
  let at = 0;
  t.mock.method(Date, "now", () => at);
  const rows = [{ ...row("worker"), state: "working" as const, workingSince: 0 }];
  const view = new SessionsPanel({ rows: () => rows, actions, close: noop });
  view.render(theme, 100, 20);
  await view.handleInput("?");
  const help = view.render(theme, 100, 20);
  at += 12345;
  assert.equal(view.needsRedraw(theme, 100, 20), false);
  assert.equal(view.render(theme, 100, 20), help);
});
