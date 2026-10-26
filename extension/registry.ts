/**
 * The registry: one file per live pi process, under
 * `~/.pi/agent/session-panel/registry/<pid>.json`.
 *
 * See docs/adr/0001. There is no fallback scan: a pi that never wrote a record
 * does not exist as far as the panel is concerned. Each process rewrites its own
 * record atomically when its state changes, and removes it when it exits.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RegistryRecord {
  pid: number;
  /** Immutable birth identity captured by this Pi. Missing in legacy records. */
  processIdentity?: string;
  /** Session JSONL path, when the session is persisted. */
  sessionFile?: string;
  /** Session name, when the user or a model gave it one. */
  name?: string;
  cwd: string;
  /** "working" while a run is in flight, "idle" otherwise. */
  state: "working" | "idle";
  /** When the current run started, epoch ms. Working only. */
  workingSince?: number;
  /** Last activity, epoch ms. */
  updatedAt: number;
  /** tmux pane target, when the session runs inside tmux. */
  pane?: string;
  /** tmux session:window.pane, for the unregistered hint and for display. */
  paneLabel?: string;
}

export function registryDir(agentDir: string): string {
  return join(agentDir, "session-panel", "registry");
}

function recordPath(dir: string, pid: number): string {
  return join(dir, String(pid), "record.json");
}

/** Read one self-reported record, binding its contents to its directory PID. */
export function readRecord(dir: string, pid: number): RegistryRecord | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const record = JSON.parse(readFileSync(recordPath(dir, pid), "utf8"));
    return record && record.pid === pid ? record as RegistryRecord : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write this process's record. Written to a temporary name and renamed so a
 * reader never sees a half-written file.
 */
export function writeRecord(dir: string, record: RegistryRecord): void {
  const path = recordPath(dir, record.pid);
  mkdirSync(join(dir, String(record.pid)), { recursive: true });
  const temp = path + ".tmp";
  writeFileSync(temp, JSON.stringify(record));
  renameSync(temp, path);
}

/** Remove this process's record and its directory. Safe to call twice. */
export function removeRecord(dir: string, pid: number): void {
  const path = recordPath(dir, pid);
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
  try {
    rmdirSync(join(dir, String(pid)));
  } catch {
    // Not empty or already gone.
  }
}

/** Whether a pid is alive. Signal 0 checks existence without touching it. */
export function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface RegistryRead {
  /** Records whose PID exists; this is a display hint, not proof of identity. */
  live: RegistryRecord[];
  /** Pids whose record was stale and has been cleaned up. */
  cleaned: number[];
}

/**
 * Read every record, drop the ones whose process is gone, and clean up their
 * files. A reused PID can keep a stale record visible. Destructive actions must
 * independently verify its registered birth identity; kill(pid, 0) is not proof.
 */
export function readRegistry(dir: string): RegistryRead {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { live: [], cleaned: [] };
  }

  const live: RegistryRecord[] = [];
  const cleaned: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0 || entry !== String(pid)) continue;
    const path = recordPath(dir, pid);
    const record = readRecord(dir, pid);
    if (!record) {
      // A record that cannot be parsed is worthless; drop it and its directory.
      try { unlinkSync(path); } catch {}
      try { rmdirSync(join(dir, entry)); } catch {}
      continue;
    }
    if (isAlive(pid)) {
      live.push(record);
    } else {
      cleaned.push(pid);
      try { unlinkSync(path); } catch {}
      try { rmdirSync(join(dir, entry)); } catch {}
    }
  }
  return { live, cleaned };
}
