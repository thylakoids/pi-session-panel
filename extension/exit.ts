import { readRecord } from "./registry.ts";
import { readProcessIdentity } from "./process-identity.ts";
import type { SessionRow } from "./types.ts";

export interface ProcessControl {
  identity: (pid: number) => string | undefined;
  kill: (pid: number, signal: "SIGTERM") => void;
}

const system: ProcessControl = {
  identity: readProcessIdentity,
  kill: (pid, signal) => { process.kill(pid, signal); },
};

/** Stop only the registered process lifetime represented by this Idle row. */
export function stopRegisteredSession(dir: string, row: SessionRow, control: ProcessControl = system): void {
  const match = /^live:([1-9]\d*)$/.exec(row.key);
  const pid = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0 || row.state !== "idle") {
    throw new Error("This session has no idle process to stop.");
  }
  const expected = row.processIdentity;
  if (typeof expected !== "string" || !expected) {
    throw new Error("Cannot confirm this Pi process's identity; refusing to stop it. Reload the target on a supported Linux host.");
  }
  // A stale row must not authorize a newly registered Pi that reused its PID.
  const record = readRecord(dir, pid);
  if (!record || record.processIdentity !== expected || record.state !== "idle" || record.sessionFile !== row.sessionFile) {
    throw new Error("This session's registration changed or disappeared; refusing to stop it. Refresh the panel.");
  }
  if (control.identity(pid) !== expected) {
    throw new Error("Cannot confirm this Pi process's identity; refusing to stop it.");
  }
  // No await between the birth check and signal, but these are NOT atomic:
  // exit + PID reuse in this gap still requires pidfd (or target-side IPC) to fix.
  try {
    control.kill(pid, "SIGTERM");
  } catch (error) {
    throw new Error(`Could not stop pid ${pid}: ${(error as Error).message}`);
  }
}
