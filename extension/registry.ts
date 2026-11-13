/** One atomic self-reported record per PID. See docs/adr/0001 and 0013. */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExitControl } from "./exit-control.ts";

export interface RegistryRecord {
  pid: number;
  /** Linux process birth identity; legacy exit compatibility only. */
  processIdentity?: string;
  /** Private, instance-authenticated shutdown channel. */
  exitControl?: ExitControl;
  sessionFile?: string;
  name?: string;
  cwd: string;
  state: "working" | "idle";
  workingSince?: number;
  updatedAt: number;
  pane?: string;
  paneLabel?: string;
}

export function registryDir(agentDir: string): string {
  return join(agentDir, "session-panel", "registry");
}
const recordPath = (dir: string, pid: number) => join(dir, String(pid), "record.json");
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;

/** Bind the record to its PID and reject malformed display fields. */
export function readRecord(dir: string, pid: number): RegistryRecord | undefined {
  if (!validPid(pid)) return undefined;
  try {
    const record = JSON.parse(readFileSync(recordPath(dir, pid), "utf8"));
    if (!record || record.pid !== pid || typeof record.cwd !== "string" ||
      !["working", "idle"].includes(record.state) || !Number.isFinite(record.updatedAt)) return undefined;
    for (const key of ["name", "sessionFile", "pane", "processIdentity"]) {
      if (record[key] !== undefined && typeof record[key] !== "string") return undefined;
    }
    if (record.workingSince !== undefined && !Number.isFinite(record.workingSince)) return undefined;
    if (record.exitControl !== undefined && (typeof record.exitControl?.endpoint !== "string" || typeof record.exitControl?.token !== "string")) return undefined;
    return record;
  } catch { return undefined; }
}

export function writeRecord(dir: string, record: RegistryRecord): void {
  const path = recordPath(dir, record.pid);
  const temp = path + "." + process.pid + ".tmp";
  mkdirSync(join(dir, String(record.pid)), { recursive: true });
  writeFileSync(temp, JSON.stringify(record));
  renameSync(temp, path);
}

export function removeRecord(dir: string, pid: number): void {
  try { unlinkSync(recordPath(dir, pid)); } catch { /* Already gone. */ }
  try { rmdirSync(join(dir, String(pid))); } catch { /* Not empty or gone. */ }
}

/** Liveness is a display hint; destructive actions must verify instance identity. */
export function isAlive(pid: number): boolean {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export interface RegistryRead {
  live: RegistryRecord[];
  cleaned: number[];
}

export function readRegistry(dir: string): RegistryRead {
  const result: RegistryRead = { live: [], cleaned: [] };
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return result; }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!validPid(pid) || entry !== String(pid)) continue;
    const record = readRecord(dir, pid);
    if (record && isAlive(pid)) result.live.push(record);
    else {
      if (record) result.cleaned.push(pid);
      removeRecord(dir, pid);
    }
  }
  return result;
}
