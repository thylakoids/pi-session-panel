/**
 * The live half of the panel: this process's own registry record, plus the rows
 * other live processes reported.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { RegistryRecord } from "./registry.ts";
import type { SessionRow } from "./types.ts";

/** The tmux pane this process runs in, if any. */
export function ownPane(): { pane?: string; label?: string } {
  const pane = process.env.TMUX_PANE;
  if (!pane) return {};
  return { pane };
}

/**
 * Derived labels, keyed by file and invalidated by size+mtime. Reading a session
 * head is ~0.4ms, and rows are rebuilt every frame, so the result has to be kept.
 */
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
  labelCache.set(sessionFile, { stamp, label });
  return label;
}

/**
 * First user message in a session file, collapsed.
 *
 * Reads at most the first 256 KiB: the first user message is always near the top,
 * and some session files here are over 2 MiB.
 */
function firstUserMessage(sessionFile: string): string | undefined {
  let head: string;
  try {
    const fd = openSync(sessionFile, "r");
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      head = buffer.toString("utf8", 0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  for (const line of head.split("\n")) {
    if (!line.includes('"role":"user"')) continue;
    try {
      const entry = JSON.parse(line) as { message?: { content?: unknown } };
      const content = entry.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "")).join(" ")
            : "";
      const first = text.split("\n").find((part) => part.trim().length > 0);
      const collapsed = first?.replace(/\s+/g, " ").trim();
      if (collapsed) return collapsed.length > 100 ? collapsed.slice(0, 100) + "…" : collapsed;
    } catch {
      // Skip unparseable lines and keep looking.
    }
  }
  return undefined;
}

/**
 * Turn a registry record into a panel row.
 *
 * The display name follows the same rule as `pi -r`: the session name if there is
 * one, else the first user message. A session that has not been used yet has
 * neither, and falls back to its directory.
 */
export function rowFromRecord(record: RegistryRecord): SessionRow {
  const named = record.name?.trim();
  const fromFile = named ? undefined : record.sessionFile ? cachedFirstUserMessage(record.sessionFile) : undefined;
  return {
    key: `live:${record.pid}`,
    state: record.state,
    name: named || fromFile || lastSegment(record.cwd),
    cwd: record.cwd,
    updatedAt: record.updatedAt,
    workingSince: record.workingSince,
    pane: record.pane,
    sessionFile: record.sessionFile,
  };
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * Collapse records that point at the same session file.
 *
 * Two processes can hold one session file: reopening a closed session starts a new
 * pi on it while the old one is still alive. That is one session, so it gets one
 * row, and the most recently active process represents it.
 */
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
