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
  /**
   * Everything pi -r searches in this session: its id, name, all message text and
   * cwd. Present for closed rows, which already parsed it, and filled lazily for
   * live rows the first time a search runs.
   */
  searchText?: string;
  /** Session id, shown and searched the way pi -r does. */
  sessionId?: string;
}
