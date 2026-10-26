/** All target process reads and signals in this suite are simulated. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopRegisteredSession } from "../extension/exit.ts";
import { readProcessIdentity } from "../extension/process-identity.ts";
import { readRegistry, removeRecord, writeRecord, type RegistryRecord } from "../extension/registry.ts";
import { rowFromRecord } from "../extension/live.ts";

const pid = 4242;
const bootId = "83eb1d89-c91c-47c4-8edb-84bbed5607e1";
const identity = `linux:${bootId}:123456`;
const replacementIdentity = `linux:${bootId}:123999`;

function fixture(t: TestContext, patch: Partial<RegistryRecord> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "panel-exit-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record: RegistryRecord = {
    pid, processIdentity: identity, cwd: "/project", state: "idle",
    name: "Selected Pi", sessionFile: "/sessions/selected.jsonl", updatedAt: 1, ...patch,
  };
  writeRecord(dir, record);
  const row = rowFromRecord(record);
  const events: unknown[][] = [];
  const control = {
    identity: (target: number): string | undefined => { events.push(["identity", target]); return identity; },
    kill: (target: number, signal: "SIGTERM"): void => { events.push(["kill", target, signal]); },
  };
  return { dir, record, row, control, events };
}

function assertNoSignal(events: unknown[][]) {
  assert.equal(events.filter(event => event[0] === "kill").length, 0, "refusal must never send a signal");
}

test("normal Idle exit validates the selected registration immediately before simulated SIGTERM", t => {
  const { dir, row, control, events } = fixture(t);
  assert.equal(row.processIdentity, identity, "the selected row must retain its registered birth identity");
  stopRegisteredSession(dir, row, control);
  assert.deepEqual(events, [["identity", pid], ["kill", pid, "SIGTERM"]]);
});

test("an unpersisted Idle session can exit when both registrations have no session file", t => {
  const { dir, row, control, events } = fixture(t, { sessionFile: undefined });
  stopRegisteredSession(dir, row, control);
  assert.deepEqual(events, [["identity", pid], ["kill", pid, "SIGTERM"]]);
});

test("a leftover record for a vanished process refuses exit without a signal", t => {
  const { dir, row, control, events } = fixture(t);
  control.identity = target => { events.push(["identity", target]); return undefined; };
  assert.throws(() => stopRegisteredSession(dir, row, control));
  assertNoSignal(events);
});

test("PID reuse stays non-actionable even when the old record passes kill(pid, 0)", t => {
  const { dir, control, events } = fixture(t);
  const probes: unknown[][] = [];
  t.mock.method(process, "kill", (target: number, signal: string | number) => {
    probes.push([target, signal]);
    assert.equal(signal, 0, "only a simulated liveness probe is allowed");
    return true;
  });
  const { live } = readRegistry(dir);
  assert.equal(live.length, 1, "liveness alone can still admit the stale record");
  control.identity = target => { events.push(["identity", target]); return replacementIdentity; };
  assert.throws(() => stopRegisteredSession(dir, rowFromRecord(live[0]!), control));
  assert.deepEqual(probes, [[pid, 0]]);
  assert.deepEqual(events, [["identity", pid]]);
  assertNoSignal(events);
});

test("an old selected row cannot authorize a newly registered Pi with the same PID", t => {
  const { dir, record, row, control, events } = fixture(t);
  writeRecord(dir, { ...record, processIdentity: replacementIdentity });
  control.identity = target => { events.push(["identity", target]); return replacementIdentity; };
  assert.throws(() => stopRegisteredSession(dir, row, control));
  assertNoSignal(events);
});

test("cross-boot PID and start-tick reuse is rejected", t => {
  const { dir, row, control, events } = fixture(t);
  control.identity = () => `linux:cf735819-112e-430a-819f-e182c6ff573c:123456`;
  assert.throws(() => stopRegisteredSession(dir, row, control));
  assertNoSignal(events);
});

test("identity read errors and permission failures fail closed", t => {
  for (const code of ["EACCES", "EPERM", "ENOENT"]) {
    const { dir, row, control, events } = fixture(t);
    control.identity = () => { throw Object.assign(new Error(code), { code }); };
    assert.throws(() => stopRegisteredSession(dir, row, control));
    assertNoSignal(events);
  }
});

test("legacy or empty identities never acquire authority from a currently live PID", t => {
  for (const processIdentity of [undefined, ""]) {
    const { dir, row, control, events } = fixture(t, { processIdentity });
    assert.throws(() => stopRegisteredSession(dir, row, control));
    assert.deepEqual(events, [], "do not backfill a legacy record from the current PID occupant");
  }
});

test("loss of the current record refuses exit", t => {
  const { dir, row, control, events } = fixture(t);
  removeRecord(dir, pid);
  assert.throws(() => stopRegisteredSession(dir, row, control));
  assertNoSignal(events);
});

test("malformed, non-object, and mismatched-PID records never authorize a signal", t => {
  for (const content of ["{broken", "null", "[]", "42", JSON.stringify({ pid: pid + 1, processIdentity: identity, state: "idle" })]) {
    const { dir, row, control, events } = fixture(t);
    writeFileSync(join(dir, String(pid), "record.json"), content);
    assert.throws(() => stopRegisteredSession(dir, row, control));
    assertNoSignal(events);
  }
});

test("row keys must be canonical live positive safe integer PIDs", t => {
  for (const key of ["closed:4242", "4242", "live:0", "live:-1", "live:1.5", "live:4242tail", "live:4242\n", "live:9007199254740992", "live:Infinity", "live:NaN", "live: 4242", "live:+4242", "live:04242"]) {
    const { dir, row, control, events } = fixture(t);
    assert.throws(() => stopRegisteredSession(dir, { ...row, key }, control), key);
    assertNoSignal(events);
  }
});

test("a non-Idle selected row refuses exit", t => {
  for (const state of ["working", "closed"] as const) {
    const { dir, row, control, events } = fixture(t);
    assert.throws(() => stopRegisteredSession(dir, { ...row, state }, control));
    assertNoSignal(events);
  }
});

test("a selected Idle session that has started working refuses exit", t => {
  const { dir, record, row, control, events } = fixture(t);
  writeRecord(dir, { ...record, state: "working" });
  assert.throws(() => stopRegisteredSession(dir, row, control));
  assertNoSignal(events);
});

test("a process that switched session files after selection refuses exit", t => {
  const { dir, record, row, control, events } = fixture(t);
  writeRecord(dir, { ...record, sessionFile: "/sessions/replacement.jsonl" });
  assert.throws(() => stopRegisteredSession(dir, row, control));
  assertNoSignal(events);
});

test("removal of the registered identity after selection refuses exit", t => {
  const { dir, record, row, control, events } = fixture(t);
  writeRecord(dir, { ...record, processIdentity: undefined });
  assert.throws(() => stopRegisteredSession(dir, row, control));
  assertNoSignal(events);
});

test("signal failure is surfaced without retrying another PID or signal", t => {
  for (const code of ["ESRCH", "EPERM"]) {
    const { dir, row, control, events } = fixture(t);
    control.kill = (target, signal) => {
      events.push(["kill", target, signal]);
      throw Object.assign(new Error(code), { code });
    };
    assert.throws(() => stopRegisteredSession(dir, row, control), new RegExp(code));
    assert.deepEqual(events, [["identity", pid], ["kill", pid, "SIGTERM"]]);
  }
});

function procStat(options: { pid?: number; comm?: string; state?: string; ticks?: string } = {}): string {
  // Fields 3..21: state followed by 18 fields; starttime is field 22.
  return `${options.pid ?? pid} (${options.comm ?? "pi"}) ${options.state ?? "S"} ${Array(18).fill("0").join(" ")} ${options.ticks ?? "123456"} 0 0\n`;
}

function procIO(stat = procStat(), boot = bootId) {
  const paths: string[] = [];
  return {
    paths,
    io: {
      platform: "linux" as NodeJS.Platform,
      readText: (path: string): string => {
        paths.push(path);
        if (path === "/proc/sys/kernel/random/boot_id") return boot + "\n";
        if (path === `/proc/${pid}/stat`) return stat;
        throw new Error(`unexpected process read: ${path}`);
      },
    },
  };
}

test("Linux birth identity uses boot UUID and field 22 with tricky comm text", () => {
  for (const comm of ["pi", "node pi session", "pi ) worker (nested)"]) {
    const { io, paths } = procIO(procStat({ comm }));
    assert.equal(readProcessIdentity(pid, io), identity);
    assert.ok(paths.every(path => path === `/proc/${pid}/stat` || path === "/proc/sys/kernel/random/boot_id"), "read only the requested PID and boot identity, never scan");
  }
});

test("Linux identity rejects zombies, dead processes, wrong PIDs, and malformed stat", () => {
  for (const stat of [procStat({ state: "Z" }), procStat({ state: "X" }), procStat({ pid: pid + 1 }), procStat({ ticks: "NaN" }), procStat({ ticks: "-1" }), "4242 pi S 0", "4242 (pi) S 0 0", ""]) {
    assert.equal(readProcessIdentity(pid, procIO(stat).io), undefined, stat);
  }
});

test("Linux identity rejects invalid boot identifiers and unreadable proc data", () => {
  for (const boot of ["", "not-a-boot-id", "83eb1d89-c91c-47c4-8edb-84bbed5607e1\nextra"]) {
    assert.equal(readProcessIdentity(pid, procIO(procStat(), boot).io), undefined);
  }
  for (const code of ["ENOENT", "EACCES", "EPERM"]) {
    assert.equal(readProcessIdentity(pid, {
      platform: "linux",
      readText: () => { throw Object.assign(new Error(code), { code }); },
    }), undefined);
  }
});

test("invalid PIDs and unsupported platforms cannot produce identity or trigger probing", () => {
  const readText = () => { assert.fail("unsupported targets must not be probed"); };
  for (const invalidPid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(readProcessIdentity(invalidPid, { platform: "linux", readText }), undefined);
  }
  for (const platform of ["darwin", "win32", "freebsd"] as const) {
    assert.equal(readProcessIdentity(pid, { platform, readText }), undefined);
  }
});
