/**
 * The closed section: sessions with no process, read from disk the same way
 * `pi -r` reads them. See docs/adr/0003.
 *
 * `SessionManager.listAll()` reads the head of every JSONL file, which is far too
 * slow to run on a tick. It runs once, asynchronously, and the result is kept as
 * an in-memory index. Exiting a live session inserts one row into that index
 * directly: everything needed is already known at that moment.
 */
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SessionRow } from "./types.ts";

export interface ClosedIndex {
  rows: SessionRow[];
  loadedAt: number;
}

/**
 * The session manager, as far as the scan scope is concerned.
 *
 * `usesDefaultSessionDir()` exists on pi's `SessionManager` but is not part of the
 * readonly view an extension receives, so it is optional here and probed at runtime.
 */
export interface SessionDirSource {
  getSessionDir(): string;
  usesDefaultSessionDir?: () => boolean;
}

/**
 * Which directory the closed scan covers.
 *
 * `pi -r` scans every project when the session lives in the default directory, and
 * only that directory when `--session-dir` moved it. The panel has to make the same
 * choice. Passing `getSessionDir()` unconditionally narrows the scan to the current
 * project, where the only session file is usually the one running right now: the
 * list then comes out empty, which is exactly what a closed list must not do.
 */
export function closedScanDir(source: SessionDirSource): string | undefined {
  // Without the probe, fall back to every project: that is what the panel promises.
  if (typeof source.usesDefaultSessionDir !== "function") return undefined;
  return source.usesDefaultSessionDir() ? undefined : source.getSessionDir();
}

/** First line of a message, collapsed, so a pasted blob cannot dominate the list. */
function firstLine(text: string, limit = 100): string {
  const line = text.split("\n").find((part) => part.trim().length > 0) ?? text;
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? collapsed.slice(0, limit) + "…" : collapsed;
}

/** Turn a `pi -r` record into a panel row, using pi's own display rule. */
export function rowFromInfo(info: SessionInfo): SessionRow {
  return {
    key: `closed:${info.path}`,
    state: "closed",
    // pi -r shows the name, else the first user message, else "(no messages)".
    name: info.name ?? firstLine(info.firstMessage),
    cwd: info.cwd,
    updatedAt: info.modified.getTime(),
    sessionFile: info.path,
    sessionId: info.id,
    // Exactly what pi -r matches against.
    searchText: `${info.id} ${info.name ?? ""} ${info.allMessagesText} ${info.cwd}`,
  };
}

/** Load every session on disk. Slow; call from an async context, never per frame. */
export async function loadClosed(sessionDir?: string, signal?: AbortSignal): Promise<SessionRow[]> {
  const infos = sessionDir
    ? await SessionManager.listAll(sessionDir, undefined, signal)
    : await SessionManager.listAll(undefined, signal);
  return infos.map(rowFromInfo).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Insert one row into an existing index, keeping it sorted. This is what makes
 * "exit a session and watch it appear in Closed" instant instead of a rescan.
 */
export function insertClosed(index: ClosedIndex, row: SessionRow): ClosedIndex {
  if (index.rows.some((r) => r.key === row.key)) return index;
  const at = index.rows.findIndex((r) => r.updatedAt < row.updatedAt);
  const rows = [...index.rows];
  rows.splice(at < 0 ? rows.length : at, 0, row);
  return { ...index, rows };
}
