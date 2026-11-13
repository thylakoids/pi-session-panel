/** Incremental history index; session parsing stays with Pi. See docs/adr/0011. */
import { readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { CachedClosedRow } from "./closed-cache.ts";
import type { SessionRow } from "./types.ts";

export interface ClosedIndex {
  rows: SessionRow[];
  loadedAt: number;
}

export interface SessionDirSource {
  getSessionDir(): string;
  usesDefaultSessionDir?: () => boolean;
}

export function closedScanDir(source: SessionDirSource): string | undefined {
  return source.usesDefaultSessionDir?.() === false ? source.getSessionDir() : undefined;
}

const SUBAGENT_SIDECARS = [".loadout.json", ".cli.json"];
export function isSubagentSession(file: string): boolean {
  return Boolean(file) && SUBAGENT_SIDECARS.some(suffix => existsSync(file + suffix));
}

/** Only discard positively identified metadata-only sessions; malformed/unknown data is retained. */
export function isEmptySession(file: string): boolean {
  try {
    const entries = readFileSync(file, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
    return entries.every(entry => entry && ["session", "model_change", "thinking_level_change", "session_info", "custom"].includes(entry.type));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Call only after the user has requested this idle session's exit. */
export function discardEmptySession(file: string | undefined): boolean {
  if (!file) return true;
  if (!isEmptySession(file)) return false;
  rmSync(file, { force: true });
  return true;
}

export function rowFromInfo(info: SessionInfo): SessionRow {
  const first = (info.firstMessage.split("\n").find(line => line.trim()) ?? "").replace(/\s+/g, " ").trim();
  return {
    key: "closed:" + info.path,
    state: "closed",
    name: info.name ?? (first ? first.slice(0, 100) + (first.length > 100 ? "…" : "") : "(new session)"),
    cwd: info.cwd,
    updatedAt: info.modified.getTime(),
    sessionFile: info.path,
    sessionId: info.id,
    searchText: [info.id, info.name ?? "", info.allMessagesText, info.cwd].join(" "),
  };
}

export interface ClosedScan {
  rows: SessionRow[];
  cache: CachedClosedRow[];
}

/** Directory-level parsing is Pi's public API; unchanged directories require no reads. */
export async function scanClosed(
  sessionDir?: string,
  previous: readonly CachedClosedRow[] = [],
  signal?: AbortSignal,
): Promise<ClosedScan> {
  signal?.throwIfAborted();
  const root = join(getAgentDir(), "sessions");
  let directories: string[];
  try {
    directories = sessionDir ? [sessionDir] : (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => join(root, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    directories = [];
  }
  const cached = new Map(previous.map(entry => [entry.row.sessionFile, entry]));
  const cache: CachedClosedRow[] = [];
  for (const directory of directories) {
    signal?.throwIfAborted();
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    const entries = new Set(names);
    const files: { path: string; stamp: string }[] = [];
    for (const name of names) {
      signal?.throwIfAborted();
      if (!name.endsWith(".jsonl") || SUBAGENT_SIDECARS.some(suffix => entries.has(name + suffix))) continue;
      const path = join(directory, name);
      try {
        const stats = await stat(path);
        files.push({ path, stamp: stats.size + ":" + stats.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const changed = files.some(file => cached.get(file.path)?.stamp !== file.stamp);
    if (!changed) {
      for (const file of files) cache.push(cached.get(file.path)!);
      continue;
    }
    try {
      const infos = new Map((await SessionManager.listAll(directory, undefined, signal)).map(info => [info.path, info]));
      for (const file of files) {
        const info = infos.get(file.path);
        if (info && (info.messageCount > 0 || !isEmptySession(file.path))) cache.push({ row: rowFromInfo(info), stamp: file.stamp });
      }
    } catch {
      signal?.throwIfAborted();
      // Keep the old stamp after a failed refresh so the next scan retries.
      for (const file of files) {
        const old = cached.get(file.path);
        if (old) cache.push(old);
      }
    }
  }
  signal?.throwIfAborted();
  return { rows: cache.map(entry => entry.row).sort((a, b) => b.updatedAt - a.updatedAt), cache };
}

export function insertClosed(index: ClosedIndex, row: SessionRow): ClosedIndex {
  const position = index.rows.findIndex(existing => existing.key === row.key);
  const previous = index.rows[position];
  const rows = index.rows.filter(existing => existing.key !== row.key);
  row = { ...previous, ...row };
  const at = previous?.updatedAt === row.updatedAt ? position : rows.findIndex(existing => existing.updatedAt < row.updatedAt);
  rows.splice(at < 0 ? rows.length : at, 0, row);
  return { ...index, rows };
}
