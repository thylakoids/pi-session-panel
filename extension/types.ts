/** Shared vocabulary for the panel. See GLOSSARY.md. */

export type SessionState = "working" | "idle" | "closed";

export interface SessionRow {
  /** Stable identity for selection: registry pid for live rows, file path for closed. */
  key: string;
  state: SessionState;
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
}
