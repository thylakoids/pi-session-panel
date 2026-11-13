import type { ExitControl } from "./exit-control.ts";
/** Shared vocabulary for the panel. See GLOSSARY.md. */

export type SessionState = "working" | "idle" | "closed";

export interface SessionRow {
  /** Stable identity for selection: registry pid for live rows, file path for closed. */
  key: string;
  /** Registered process birth identity, retained even if the PID is reused. */
  processIdentity?: string;
  /** Target-owned exit channel, available after loading the updated extension. */
  exitControl?: ExitControl;
  state: SessionState;
  /** The panel's host session, independent of the keyboard selection. */
  current?: boolean;
  /** Display name, already resolved the way `pi -r` resolves it. */
  name: string;
  cwd: string;
  /** Wall clock of the last activity, epoch ms. Drives the age of idle and closed rows. */
  updatedAt: number;
  /** When the current run started, epoch ms. Working rows only. */
  workingSince?: number;
  /** tmux pane target, when the session runs inside tmux. Enables focus and Escape. */
  pane?: string;
  /** Session JSONL path. Closed rows and live rows that know their file. */
  sessionFile?: string;
  /** Search haystack: session ID, name, message text and working directory. */
  searchText?: string;
  /** Session id, shown and searched the way pi -r does. */
  sessionId?: string;
}

/** Exact row equality shared by snapshots and the mutable-source fallback. */
export function sameRows(a: readonly SessionRow[], b: readonly SessionRow[]): boolean {
  return a.length === b.length && a.every((r, i) => {
    const p = b[i]!;
    return r === p || (r.key === p.key && r.state === p.state && r.name === p.name && r.cwd === p.cwd &&
      r.updatedAt === p.updatedAt && r.workingSince === p.workingSince && r.current === p.current &&
      r.searchText === p.searchText && r.sessionId === p.sessionId && r.sessionFile === p.sessionFile &&
      r.pane === p.pane && r.processIdentity === p.processIdentity &&
      r.exitControl?.endpoint === p.exitControl?.endpoint && r.exitControl?.token === p.exitControl?.token);
  });
}
