/** Real local IPC transport, only simulated shutdown callbacks; no process signals. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer, createConnection } from "node:net";
import { createExitControl, requestExit } from "../extension/exit-control.ts";
import { stopRegisteredSession } from "../extension/exit.ts";
import { writeRecord, removeRecord } from "../extension/registry.ts";
import { rowFromRecord } from "../extension/live.ts";

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "panel-exit-test-"));
  const target = { pid: 424242, sessionFile: "/fixture/selected.jsonl" as string | undefined, idle: true };
  let shutdowns = 0;
  const server = await createExitControl({ target: () => target, shutdown: () => { shutdowns++; } });
  const record = { pid: target.pid, state: "idle" as const, sessionFile: target.sessionFile,
    cwd: "/fixture", updatedAt: 1, exitControl: server.registration };
  writeRecord(dir, record);
  const row = rowFromRecord(record);
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, target, server, record, row, shutdowns: () => shutdowns };
}

test("Darwin supports target-owned Idle shutdown without a Linux birth identity", async t => {
  const f = await fixture(t);
  assert.equal(f.row.processIdentity, undefined);
  assert.deepEqual(f.row.exitControl, f.server.registration);
  await stopRegisteredSession(f.dir, f.row, {
    identity: () => assert.fail("new instances do not need a Linux identity probe"),
    kill: () => assert.fail("never signal a PID for channel exit"),
  });
  assert.equal(f.shutdowns(), 1);
});

test("stale credentials cannot shut down a reused PID or a replacement instance", async t => {
  const f = await fixture(t);
  await assert.rejects(requestExit({ ...f.server.registration, token: "old-instance" }, f.target), /instance changed/);
  writeRecord(f.dir, { ...f.record, exitControl: { ...f.server.registration, token: "new-instance" } });
  assert.throws(() => stopRegisteredSession(f.dir, f.row), /registration changed/);
  assert.equal(f.shutdowns(), 0);
});

test("the target rechecks Idle and session file even if registry still says Idle", async t => {
  const f = await fixture(t);
  f.target.idle = false;
  await assert.rejects(Promise.resolve(stopRegisteredSession(f.dir, f.row)), /no longer idle/);
  f.target.idle = true;
  f.target.sessionFile = "/fixture/replacement.jsonl";
  await assert.rejects(Promise.resolve(stopRegisteredSession(f.dir, f.row)), /session changed/);
  await assert.rejects(requestExit(f.server.registration, { ...f.target, pid: 1 }), /session changed/);
  assert.equal(f.shutdowns(), 0);
});

test("changed registrations, removed records and Working rows refuse exit", async t => {
  const f = await fixture(t);
  assert.throws(() => stopRegisteredSession(f.dir, { ...f.row, state: "working" }), /idle process/);
  writeRecord(f.dir, { ...f.record, state: "working" });
  assert.throws(() => stopRegisteredSession(f.dir, f.row), /registration changed/);
  removeRecord(f.dir, f.record.pid);
  assert.throws(() => stopRegisteredSession(f.dir, f.row), /registration changed/);
  assert.equal(f.shutdowns(), 0);
});

test("an unpersisted session can exit and duplicate requests cannot repeat shutdown", async t => {
  const f = await fixture(t);
  f.target.sessionFile = undefined;
  writeRecord(f.dir, { ...f.record, sessionFile: undefined });
  const row = { ...f.row, sessionFile: undefined };
  await stopRegisteredSession(f.dir, row);
  await assert.rejects(Promise.resolve(stopRegisteredSession(f.dir, row)), /unavailable/);
  assert.equal(f.shutdowns(), 1);
});

test("closed/reloaded channels remove their private endpoint and refuse old requests", async t => {
  const f = await fixture(t);
  const old = f.server.registration;
  f.server.close();
  assert.equal(existsSync(dirname(old.endpoint)), false);
  await assert.rejects(requestExit(old, f.target), /Cannot contact/);
  const next = await createExitControl({ target: () => f.target, shutdown: () => {} });
  t.after(() => next.close());
  assert.notEqual(next.registration.token, old.token);
  assert.notEqual(next.registration.endpoint, old.endpoint);
  await assert.rejects(requestExit({ ...next.registration, token: old.token }, f.target), /instance changed/);
});

test("failed control channels never fall back to an OS signal", async t => {
  const f = await fixture(t);
  f.server.close();
  await assert.rejects(Promise.resolve(stopRegisteredSession(f.dir, f.row, {
    identity: () => assert.fail("no identity fallback"), kill: () => assert.fail("no signal fallback"),
  })), /Cannot contact/);
});

test("unresponsive targets have a bounded wait", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-exit-timeout-"));
  const endpoint = join(dir, "s.sock");
  const sockets: import("node:net").Socket[] = [];
  const server = createServer(socket => { sockets.push(socket); socket.on("error", () => {}); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(requestExit({ endpoint, token: "fixture" }, { pid: 1 }), /did not answer/);
});


test("a legacy selected row cannot bypass a newly registered control channel", async t => {
  const f = await fixture(t);
  writeRecord(f.dir, { ...f.record, processIdentity: "linux:fixture:1" });
  const old = { ...f.row, exitControl: undefined, processIdentity: "linux:fixture:1" };
  assert.throws(() => stopRegisteredSession(f.dir, old, {
    identity: () => assert.fail("refresh the selected row instead of probing"),
    kill: () => assert.fail("never fall back to SIGTERM for an upgraded target"),
  }), /registration changed/);
  assert.equal(f.shutdowns(), 0);
});


test("UTF-8 session paths survive transport chunks split inside a character", async t => {
  const f = await fixture(t);
  f.target.sessionFile = "/fixture/会话.jsonl";
  const payload = Buffer.from(JSON.stringify({ action: "exit", token: f.server.registration.token, ...f.target }) + "\n");
  const split = payload.indexOf(Buffer.from("会")) + 1;
  const response = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(f.server.registration.endpoint);
    socket.setEncoding("utf8");
    let text = "";
    socket.on("error", reject);
    socket.on("data", chunk => { text += chunk; });
    socket.on("end", () => resolve(text));
    socket.on("connect", () => {
      socket.write(payload.subarray(0, split));
      setTimeout(() => socket.write(payload.subarray(split)), 10);
    });
  });
  assert.deepEqual(JSON.parse(response), { ok: true });
  assert.equal(f.shutdowns(), 1);
});
