/** Best-effort atomic history cache. See docs/adr/0011. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRow } from "./types.ts";

export const CACHE_VERSION = 2;
export interface CachedClosedRow {
  row: SessionRow;
  stamp: string;
}
export interface ClosedCacheFile {
  version: number;
  savedAt: number;
  rows: CachedClosedRow[];
}

export function readClosedCache(path: string): ClosedCacheFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.rows)) return null;
    if (!parsed.rows.every((entry: CachedClosedRow) => entry && typeof entry.stamp === "string" &&
      entry.row?.state === "closed" && typeof entry.row.key === "string" && typeof entry.row.name === "string" &&
      typeof entry.row.cwd === "string" && Number.isFinite(entry.row.updatedAt) &&
      (entry.row.searchText === undefined || typeof entry.row.searchText === "string") &&
      (entry.row.sessionFile === undefined || typeof entry.row.sessionFile === "string"))) return null;
    return { version: CACHE_VERSION, savedAt: Number(parsed.savedAt) || 0, rows: parsed.rows };
  } catch { return null; }
}

export function writeClosedCache(path: string, rows: CachedClosedRow[]): void {
  const temp = path + "." + process.pid + ".tmp";
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), rows }));
    renameSync(temp, path);
  } catch { /* A failed cache must not break the panel. */ }
}
