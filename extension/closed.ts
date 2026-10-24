/**
 * The closed section: sessions with no process, read from disk the same way
 * `pi -r` reads them. See docs/adr/0003 and docs/adr/0011.
 *
 * `SessionManager.listAll()` reads the head of every JSONL file, which is far too
 * slow to run on a tick: 185 sessions here take ~1.6s. So the scan is
 * incremental — each file is stamped with `size:mtimeMs`, and a file whose stamp
 * is unchanged reuses the row from the last scan instead of being parsed again.
 * With the result cached on disk, a fresh pi shows the list from the previous
 * scan instantly and refreshes only what changed.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { CachedClosedRow } from "./closed-cache.ts";
import type { SessionRow } from "./types.ts";

export interface ClosedIndex {
  rows: SessionRow[];
  loadedAt: number;
}

/** A session file the scan will look at, with the stamp that decides its freshness. */
interface SessionFile {
  path: string;
  /** `size:mtimeMs`. Parsing a file whose stamp is unchanged is wasted work. */
  stamp: string;
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

/**
 * Sidecars pi-interactive-subagents writes next to a session file it spawned.
 *
 * A subagent session is not a session the user started: nobody resumes it from this
 * panel, and its parent owns its lifetime. The header field `parentSession` cannot
 * identify one on its own — it covers only 1303 of the 1794 subagent files here,
 * and it also marks ordinary forks, which must stay visible. The sidecar does
 * identify them: every spawn writes one, and no other producer writes one.
 */
const SUBAGENT_SIDECARS = [".loadout.json", ".cli.json"];

/**
 * Whether a session file was spawned as a subagent rather than started by a user.
 *
 * One or two stats, no read. See docs/adr/0010.
 */
export function isSubagentSession(sessionFile: string): boolean {
  if (!sessionFile) return false;
  return SUBAGENT_SIDECARS.some((suffix) => existsSync(sessionFile + suffix));
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
    // pi -r shows the name, else the first user message. A file with neither -- a
    // session that was opened and never used -- carries no information at all, and
    // a label beats a blank row or a bare directory name.
    name: info.name ?? (firstLine(info.firstMessage) || "(new session)"),
    cwd: info.cwd,
    updatedAt: info.modified.getTime(),
    sessionFile: info.path,
    sessionId: info.id,
    // Exactly what pi -r matches against.
    searchText: `${info.id} ${info.name ?? ""} ${info.allMessagesText} ${info.cwd}`,
  };
}

/** The directory that holds every project's session directory. */
function sessionsRoot(): string {
  return join(getAgentDir(), "sessions");
}

/**
 * Every session file the scan should consider, grouped by directory.
 *
 * Subagent sessions are dropped here, before anything is read: they are the bulk
 * of the files (1794 of 1979 on this machine) and none of them ever appears in the
 * list, so reading them is pure waste.
 *
 * Returns an empty list for a directory that does not exist yet.
 */
function scanFiles(sessionDir?: string): Map<string, SessionFile[]> {
  const byDir = new Map<string, SessionFile[]>();

  const collect = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const files: SessionFile[] = [];
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      if (isSubagentSession(path)) continue;
      let stamp: string;
      try {
        const stat = statSync(path);
        stamp = `${stat.size}:${stat.mtimeMs}`;
      } catch {
        // A file that vanished between readdir and stat is simply not there.
        continue;
      }
      files.push({ path, stamp });
    }
    if (files.length > 0) byDir.set(dir, files);
  };

  if (sessionDir) {
    collect(sessionDir);
    return byDir;
  }

  let projects: string[];
  try {
    projects = readdirSync(sessionsRoot());
  } catch {
    return byDir;
  }
  for (const project of projects) {
    collect(join(sessionsRoot(), project));
  }
  return byDir;
}

/** The directory a session file lives in, as the scan groups them. */
function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

export interface ClosedScan {
  rows: SessionRow[];
  /** The scan's result, ready to be written to the on-disk cache. */
  cache: CachedClosedRow[];
}

/**
 * Scan the session files, reusing `previous` for any file whose stamp is unchanged.
 *
 * A directory is re-listed by pi when at least one of its files is new, edited or
 * gone; `SessionManager.listAll(dir)` is per-directory, so one changed session
 * costs one small directory, not the whole machine. On a typical start that is the
 * session you are in and nothing else: ~3ms instead of ~1.6s.
 */
export async function scanClosed(
  sessionDir?: string,
  previous: readonly CachedClosedRow[] = [],
  signal?: AbortSignal,
): Promise<ClosedScan> {
  const files = scanFiles(sessionDir);
  const cached = new Map<string, CachedClosedRow>();
  for (const entry of previous) {
    if (entry.row.sessionFile) cached.set(entry.row.sessionFile, entry);
  }

  /** Rows kept from the previous scan, keyed by file. */
  const reused = new Map<string, SessionRow>();
  /** Directories that have to be handed back to pi. */
  const dirty = new Set<string>();
  /** Files whose stamp matches the cache, so they are not re-parsed. */
  const fresh = new Set<string>();

  for (const [dir, entries] of files) {
    for (const file of entries) {
      const hit = cached.get(file.path);
      if (hit && hit.stamp === file.stamp) {
        reused.set(file.path, hit.row);
        fresh.add(file.path);
      } else {
        dirty.add(dir);
      }
    }
  }

  // A cached row whose file is gone means the directory changed too: the file was
  // deleted, and the re-list is what removes it from the list.
  const seen = new Set<string>();
  for (const entries of files.values()) for (const file of entries) seen.add(file.path);
  for (const path of cached.keys()) {
    if (!seen.has(path)) dirty.add(dirOf(path));
  }

  const scanned = new Map<string, CachedClosedRow>();
  for (const dir of dirty) {
    signal?.throwIfAborted();
    let infos: SessionInfo[];
    try {
      infos = await SessionManager.listAll(dir, undefined, signal);
    } catch {
      // A directory that cannot be read keeps whatever the cache remembers, so a
      // transient failure never makes sessions disappear.
      continue;
    }
    const stamps = new Map((files.get(dir) ?? []).map((file) => [file.path, file.stamp]));
    for (const info of infos) {
      if (isSubagentSession(info.path)) continue;
      const stamp = stamps.get(info.path);
      // A file the scan did not enumerate was created after it; skip it rather
      // than cache a row whose stamp the next diff cannot match.
      if (!stamp) continue;
      scanned.set(info.path, { row: rowFromInfo(info), stamp });
    }
  }

  const cache: CachedClosedRow[] = [];
  for (const [dir, entries] of files) {
    for (const file of entries) {
      if (!fresh.has(file.path) && !scanned.has(file.path)) continue;
      const entry = scanned.get(file.path) ?? { row: reused.get(file.path)!, stamp: file.stamp };
      // A dirty directory was re-listed; a file pi did not return there is gone.
      if (dirty.has(dir) && !scanned.has(file.path)) continue;
      cache.push(entry);
    }
  }

  const rows = cache.map((entry) => entry.row).sort((a, b) => b.updatedAt - a.updatedAt);
  return { rows, cache };
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
