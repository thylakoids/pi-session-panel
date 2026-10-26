/** Exercise the production extension and X-key path; no real process is signalled. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extension/index.ts";
import { readRecord, registryDir, removeRecord, writeRecord } from "../extension/registry.ts";

const boot = "2f044161-4116-47ed-a497-b17599ab18b3";
const targetPid = 804242;
const targetIdentity = `linux:${boot}:500`;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text };

function harness(t: TestContext) {
  const dir = fs.mkdtempSync(join(tmpdir(), "panel-exit-integration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const starts = new Map([[process.pid, "100"], [targetPid, "500"]]);
  const procReads: string[] = [];
  const signals: [number, string | number | undefined][] = [];
  const originalRead = fs.readFileSync;
  const readMock = t.mock.method(fs, "readFileSync", ((path: any, ...args: any[]) => {
    if (typeof path === "string" && path.startsWith("/proc/")) {
      procReads.push(path);
      if (path === "/proc/sys/kernel/random/boot_id") return boot + "\n";
      const match = /^\/proc\/(\d+)\/stat$/.exec(path);
      const pid = match ? Number(match[1]) : NaN;
      const start = starts.get(pid);
      if (start === undefined) throw Object.assign(new Error("simulated missing process"), { code: "ENOENT" });
      return `${pid} (pi) S ${Array(18).fill("0").join(" ")} ${start} 0 0\n`;
    }
    return (originalRead as any)(path, ...args);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    assert.ok(pid === process.pid || pid === targetPid, "unexpected target PID");
    assert.ok(signal === 0 || signal === "SIGTERM", "unexpected process signal");
    signals.push([pid, signal]);
    return true;
  });
  const hooks = new Map<string, Function>();
  const commands = new Map<string, any>();
  let component: any;
  let finish: (() => void) | undefined;
  let command: Promise<void> | undefined;
  const context: any = {
    mode: "tui", hasUI: true,
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionName: () => "Host Pi",
      getSessionDir: () => join(dir, "sessions"),
      usesDefaultSessionDir: () => false,
    },
    ui: {
      notify() {}, setEditorComponent() {},
      custom: (build: Function) => new Promise<void>(resolve => {
        finish = () => { component?.dispose(); resolve(); };
        component = build({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, finish);
      }),
    },
  };
  extension({
    on: (event: string, hook: Function) => hooks.set(event, hook),
    registerCommand: (name: string, value: any) => commands.set(name, value),
    setSessionName() {},
  } as any);
  hooks.get("session_start")!({}, context);
  const registry = registryDir(dir);
  t.after(async () => {
    finish?.();
    await command;
    hooks.get("session_shutdown")?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    readMock.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    starts, procReads, signals, hooks, registry,
    registered: () => readRecord(registry, process.pid),
    async openTarget() {
      removeRecord(registry, process.pid);
      writeRecord(registry, { pid: targetPid, processIdentity: targetIdentity, state: "idle", name: "Target Pi", cwd: dir, updatedAt: 1 });
      command = commands.get("sessions").handler("", context);
      await settle();
      assert.ok(component.render(180).join("\n").includes("Target Pi"));
    },
    async pressX() {
      component.handleInput("x");
      await settle();
      return component.render(180).join("\n");
    },
  };
}

test("extension captures its own birth once and retains it across state publications", { skip: process.platform !== "linux" }, t => {
  const h = harness(t);
  const expected = `linux:${boot}:100`;
  assert.equal(h.registered()?.processIdentity, expected);
  h.starts.set(process.pid, "999");
  h.hooks.get("agent_start")!();
  assert.equal(h.registered()?.state, "working");
  assert.equal(h.registered()?.processIdentity, expected);
  h.hooks.get("agent_settled")!();
  assert.equal(h.registered()?.state, "idle");
  assert.equal(h.registered()?.processIdentity, expected);
  assert.equal(h.procReads.filter(path => path === `/proc/${process.pid}/stat`).length, 1);
  assert.equal(h.signals.filter(([, signal]) => signal !== 0).length, 0);
});

test("production X-key sends exactly one simulated SIGTERM to the matching registered Pi", { skip: process.platform !== "linux" }, async t => {
  const h = harness(t);
  await h.openTarget();
  const screen = await h.pressX();
  assert.doesNotMatch(screen, /refusing to stop/);
  assert.deepEqual(h.signals.filter(([, signal]) => signal !== 0), [[targetPid, "SIGTERM"]]);
  assert.equal(h.procReads.filter(path => path === `/proc/${targetPid}/stat`).length, 1);
});

test("production X-key refuses a reused live PID and shows the identity error", { skip: process.platform !== "linux" }, async t => {
  const h = harness(t);
  await h.openTarget();
  h.starts.set(targetPid, "999");
  const screen = await h.pressX();
  assert.match(screen, /Cannot confirm this Pi process's identity; refusing to stop it/);
  assert.ok(h.signals.some(([pid, signal]) => pid === targetPid && signal === 0), "old registry record was admitted by mocked liveness probes");
  assert.equal(h.signals.filter(([, signal]) => signal !== 0).length, 0);
});

test("production X-key refuses a leftover record when identity lookup finds no process", { skip: process.platform !== "linux" }, async t => {
  const h = harness(t);
  await h.openTarget();
  h.starts.delete(targetPid);
  const screen = await h.pressX();
  assert.match(screen, /Cannot confirm this Pi process's identity; refusing to stop it/);
  assert.equal(h.signals.filter(([, signal]) => signal !== 0).length, 0);
});
