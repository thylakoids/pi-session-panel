/**
 * The closed index, cached on disk. See docs/adr/0011.
 *
 * Scanning every session file takes ~1.8s on this machine. Opening a panel has to
 * be instant, so the last scan is kept as JSON keyed by a per-file stamp
 * (size:mtimeMs): a file whose stamp is unchanged does not need to be read again.
 *
 * Nothing here knows how a session is parsed. It stores rows, and `closed.ts`
 * decides when a row is still valid.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRow } from "./types.ts";

/** Bumped whenever the filtering or naming rules change, so old caches are dropped. */
export const CACHE_VERSION = 1;

export interface CachedClosedRow {
  row: SessionRow;
  /** `size:mtimeMs` of the session file when the row was built. */
  stamp: string;
}

export interface ClosedCacheFile {
  version: number;
  savedAt: number;
  rows: CachedClosedRow[];
}

/**
 * Read the cache, or null when there is none, it is from another version, or it
 * is unreadable. A broken cache must never be worse than no cache.
 */
export function readClosedCache(path: string): ClosedCacheFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ClosedCacheFile>;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.rows)) return null;
    return { version: CACHE_VERSION, savedAt: Number(parsed.savedAt) || 0, rows: parsed.rows };
  } catch {
    return null;
  }
}

/**
 * Write the cache atomically: a reader either sees the previous file or the new
 * one, never a half-written list.
 *
 * Failure is silent. The cache is an optimisation, and a read-only agent dir must
 * not break the panel.
 */
export function writeClosedCache(path: string, rows: CachedClosedRow[]): void {
  const payload: ClosedCacheFile = { version: CACHE_VERSION, savedAt: Date.now(), rows };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = path + ".tmp";
    writeFileSync(temp, JSON.stringify(payload));
    renameSync(temp, path);
  } catch {
    // Best effort.
  }
}
