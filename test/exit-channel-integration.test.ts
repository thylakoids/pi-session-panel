/** Exercise the actual extension and X key on macOS/Linux; shutdown is simulated. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extension/index.ts";
import { readRecord, registryDir } from "../extension/registry.ts";
import { stopRegisteredSession } from "../extension/exit.ts";
import { rowFromRecord } from "../extension/live.ts";

const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text };
async function until(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check()) { assert.ok(Date.now() < deadline, "local channel must become ready"); await new Promise(resolve => setImmediate(resolve)); }
}
async function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "panel-exit-host-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const hooks = new Map<string, Function>(), commands = new Map<string, any>();
  let view: any, finish: (() => void) | undefined, opened: Promise<void> | undefined;
  let shutdowns = 0, idle = true, file = "/fixture/current.jsonl";
  const context: any = {
    mode: "tui", hasUI: true, isIdle: () => idle,
    shutdown: () => { shutdowns++; hooks.get("session_shutdown")!({ reason: "quit" }, context); },
    sessionManager: { getSessionFile: () => file, getSessionName: () => "Fixture Pi", getSessionDir: () => join(dir, "sessions"), usesDefaultSessionDir: () => false },
    ui: { notify() {}, setEditorComponent() {}, custom: (build: Function) => new Promise<void>(resolve => {
      finish = () => { view?.dispose(); resolve(); };
      view = build({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, finish);
    }) },
  };
  const install = () => extension({ on: (event: string, handler: Function) => hooks.set(event, handler), registerCommand: (name: string, value: any) => commands.set(name, value), setSessionName() {} } as any);
  install();
  const registry = registryDir(dir);
  const record = () => readRecord(registry, process.pid);
  const start = async () => { hooks.get("session_start")!({}, context); await until(() => Boolean(record()?.exitControl)); };
  await start();
  t.after(async () => {
    finish?.(); await opened;
    hooks.get("session_shutdown")?.({ reason: "quit" }, context);
    await new Promise(resolve => setImmediate(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    hooks, context, registry, record, shutdowns: () => shutdowns,
    working: () => { idle = false; hooks.get("agent_start")!(); },
    changeSession: () => { file = "/fixture/replacement.jsonl"; },
    async reload() { hooks.get("session_shutdown")!({ reason: "reload" }, context); install(); await start(); },
    async pressX() {
      opened = commands.get("sessions").handler("", context);
      await until(() => Boolean(view));
      view.render(120);
      view.handleInput("x");
      await until(() => shutdowns > 0 || view.render(120).join("\n").includes("exit registration"));
    },
  };
}

test("production macOS/Linux Idle X-key uses the target's shutdown callback", async t => {
  const h = await harness(t);
  const registration = h.record()!.exitControl!;
  await h.pressX();
  assert.equal(h.shutdowns(), 1);
  assert.equal(h.record(), undefined);
  assert.equal(existsSync(registration.endpoint), false);
});

test("reload gives the same PID a new endpoint and invalidates an old selected row", async t => {
  const h = await harness(t);
  const old = rowFromRecord(h.record()!);
  await h.reload();
  const current = h.record()!;
  assert.notDeepEqual(current.exitControl, old.exitControl);
  assert.equal(existsSync(old.exitControl!.endpoint), false);
  assert.throws(() => stopRegisteredSession(h.registry, old), /registration changed/);
  assert.equal(h.shutdowns(), 0);
  await stopRegisteredSession(h.registry, rowFromRecord(current));
  assert.equal(h.shutdowns(), 1);
});

test("target rejects Working and session changes even before its registry refresh", async t => {
  const h = await harness(t);
  const row = rowFromRecord(h.record()!);
  // Keep registry Idle to exercise the target's own fresh state check.
  h.context.isIdle = () => false;
  await assert.rejects(Promise.resolve(stopRegisteredSession(h.registry, row)), /no longer idle/);
  h.context.isIdle = () => true;
  h.changeSession();
  await assert.rejects(Promise.resolve(stopRegisteredSession(h.registry, row)), /session changed/);
  assert.equal(h.shutdowns(), 0);
});

test("shutdown during asynchronous channel startup cannot resurrect a registration", async t => {
  const h = await harness(t);
  h.hooks.get("session_start")!({}, h.context);
  h.hooks.get("session_shutdown")!({ reason: "reload" }, h.context);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.record(), undefined);
  assert.equal(h.shutdowns(), 0);
});
