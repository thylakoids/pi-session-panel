/** Registry records projected into live session rows. */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { RegistryRecord } from "./registry.ts";
import { sameRows, type SessionRow } from "./types.ts";

/** Bounded fallback-label cache, invalidated by file size and mtime. */
const labelCache = new Map<string, { stamp: string; label: string | undefined }>();

function cachedFirstUserMessage(sessionFile: string): string | undefined {
  let stamp = "";
  try {
    const stat = statSync(sessionFile);
    stamp = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
  const hit = labelCache.get(sessionFile);
  if (hit && hit.stamp === stamp) return hit.label;
  const label = firstUserMessage(sessionFile);
  if (labelCache.size >= 256) labelCache.delete(labelCache.keys().next().value!);
  labelCache.set(sessionFile, { stamp, label });
  return label;
}

/** First user message in a session file, collapsed. */
function firstUserMessage(sessionFile: string): string | undefined {
  let head: string;
  try {
    const fd = openSync(sessionFile, "r");
    try {
      const buffer = Buffer.allocUnsafe(256 * 1024);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      head = buffer.toString("utf8", 0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  for (const line of head.split("\n")) {
    if (!/"role"\s*:\s*"user"/.test(line)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.message?.role !== "user") continue;
      const content = entry.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.map(part => typeof part?.text === "string" ? part.text : "").join(" ") : "";
      const first = text.split("\n").find((part) => part.trim().length > 0);
      const collapsed = first?.replace(/\s+/g, " ").trim();
      if (collapsed) return collapsed.length > 100 ? collapsed.slice(0, 100) + "…" : collapsed;
    } catch {
      // Skip unparseable lines and keep looking.
    }
  }
  return undefined;
}

/** Turn a registry record into a panel row. */
export function rowFromRecord(record: RegistryRecord, host?: Pick<RegistryRecord, "pid" | "sessionFile">): SessionRow {
  const named = record.name?.trim();
  const fromFile = named ? undefined : record.sessionFile ? cachedFirstUserMessage(record.sessionFile) : undefined;
  return {
    key: `live:${record.pid}`,
    processIdentity: record.processIdentity,
    exitControl: record.exitControl && { ...record.exitControl },
    state: record.state,
    current: Boolean(host && (record.pid === host.pid || (host.sessionFile && record.sessionFile === host.sessionFile))),
    name: named || fromFile || "(new session)",
    cwd: record.cwd,
    updatedAt: record.updatedAt,
    workingSince: record.workingSince,
    pane: record.pane,
    sessionFile: record.sessionFile,
  };
}

/** Collapse records that point at the same session file. */
export function dedupeLive(records: RegistryRecord[]): RegistryRecord[] {
  const byFile = new Map<string, RegistryRecord>();
  const loose: RegistryRecord[] = [];
  for (const record of records) {
    if (!record.sessionFile) {
      loose.push(record);
      continue;
    }
    const existing = byFile.get(record.sessionFile);
    if (!existing || existing.updatedAt < record.updatedAt) byFile.set(record.sessionFile, record);
  }
  return [...byFile.values(), ...loose];
}

/** Drop closed rows whose session is also running. */
export function withoutLiveDuplicates(closed: SessionRow[], live: SessionRow[]): SessionRow[] {
  const running = new Set(live.map((row) => row.sessionFile).filter((file): file is string => Boolean(file)));
  if (running.size === 0) return closed;
  return closed.filter((row) => !row.sessionFile || !running.has(row.sessionFile));
}

/** Poll live metadata once; drawing and editing consume the resulting snapshot. */
export function createRowsSource(
  readLive: () => RegistryRecord[], readClosed: () => SessionRow[] | undefined,
  host?: Pick<RegistryRecord, "pid" | "sessionFile">,
) {
  let live: SessionRow[] = [], closed: SessionRow[] | undefined;
  const source = { rows: [] as SessionRow[], version: 0, refresh() {
    const nextLive = dedupeLive(readLive()).map(record => rowFromRecord(record, host));
    const nextClosed = readClosed();
    if (nextClosed === closed && sameRows(nextLive, live)) return;
    live = nextLive;
    closed = nextClosed;
    source.rows = [...live, ...withoutLiveDuplicates(closed ?? [], live)];
    source.version++;
  } };
  return source;
}
