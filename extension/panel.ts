/**
 * The Sessions panel.
 *
 * One flat list, three stacked sections. Live rows come first because they are
 * the ones you act on; the closed section is long by nature and is the only
 * part that needs real scrolling.
 */
import { matchesKey, truncateToWidth as truncateGraphemes, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SessionRow, SessionState } from "./types.ts";
import { formatAge, formatElapsed, shortCwd } from "./format.ts";
import { matchSearch, parseSearch } from "./search.ts";

/**
 * `truncateToWidth` costs about 7us because it segments graphemes. Most rows fit
 * their column, so measure first (0.5us) and only truncate when they do not.
 *
 * `keepTail` is pi-tui's "keep the end of the string", not "pad"; the caller pads
 * separately. When the text already fits there is nothing to truncate either way,
 * so the fast path is safe for both modes.
 */
function truncateToWidth(text: string, width: number, ellipsis = "", keepTail = false): string {
  if (visibleWidth(text) <= width) return text;
  return truncateGraphemes(text, width, ellipsis, keepTail);
}

export interface PanelActions {
  /** Jump to the tmux pane. Only meaningful for live rows that live in tmux. */
  focus(row: SessionRow): void | Promise<void>;
  /** Interrupt the running turn: Escape in that session's input box. */
  interrupt(row: SessionRow): void | Promise<void>;
  /** Ask the session to exit cleanly. */
  exit(row: SessionRow): void | Promise<void>;
  /** Delete the JSONL on disk. */
  remove(row: SessionRow): void | Promise<void>;
  /** Reopen the session in a window of its own. */
  reopen(row: SessionRow): void | Promise<void>;
  rename(row: SessionRow, next: string): void | Promise<void>;
  /** Rescan the closed section from disk. */
  rescan(): void | Promise<void>;
}

export interface PanelOptions {
  rows(): SessionRow[];
  actions: PanelActions;
  /** Called when an action means "you left the panel". */
  close(): void;
}

/** Gap between two help columns: wide enough that they read as separate. */
const HELP_GAP = 4;

type Section = "working" | "idle" | "closed";
const SECTIONS: Section[] = ["working", "idle", "closed"];

const SECTION_TITLE: Record<Section, string> = {
  working: "Working",
  idle: "Idle",
  closed: "Closed",
};

/** The resting and finished glyphs. Working rows animate instead. */
const STATE_GLYPH: Record<Exclude<SessionState, "working">, string> = {
  idle: "·",
  closed: "○",
};

/**
 * The working glyph, following Claude Code 2.1.304.
 *
 * Its spinner module is six frames run ping-pong:
 *
 *   ["·","✢","✳","✶","✻","✽"] + reversed   →   12 frames
 *
 * with the index coming from `round(cosineEase(elapsed, 2000) * 5)` at a 100ms
 * tick. One out-and-back takes two seconds; because the cosine flattens at both
 * ends, the small and large glyphs linger while the middle flies past. That
 * easing, not the frame rate, is what makes it read as breathing.
 *
 * `·` is the closed end: the glyph genuinely disappears for a beat, which is the
 * "empty lungs" moment the earlier version was missing.
 */
const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"] as const;
const SPINNER_CYCLE: readonly string[] = [...SPINNER_FRAMES, ...[...SPINNER_FRAMES].reverse()];

/** Claude Code's `Kn`: one out-and-back in two seconds. */
const SPINNER_PERIOD_MS = 2000;

/** Claude Code's `qLe`: the cosine easing shared by the spinner and the glow. */
function cosineEase(elapsed: number, period: number): number {
  return (1 - Math.cos((2 * Math.PI * elapsed) / period)) / 2;
}

/**
 * Claude Code's `Zn`: quantise the eased value onto the frame ladder.
 *
 * Every working row draws from this one clock. Claude Code has a single spinner
 * per conversation and no notion of several running at once, so a list where each
 * row breathes on its own phase has no counterpart there: it reads as several
 * unrelated animations instead of one panel with work in flight.
 */
export function spinnerGlyphAt(elapsed: number): string {
  return spinnerFrame(elapsed);
}

function spinnerFrame(elapsed: number): string {
  const index = Math.round(cosineEase(elapsed, SPINNER_PERIOD_MS) * (SPINNER_FRAMES.length - 1));
  return SPINNER_CYCLE[index % SPINNER_CYCLE.length]!;
}

/** Age shown on the right of a row. Working counts to the second, the rest coarsely. */
function ageOf(row: SessionRow, at = Date.now()): string {
  return row.state === "working"
    ? formatElapsed(at - (row.workingSince ?? row.updatedAt))
    : formatAge(row.updatedAt, at);
}

/**
 * pi -r's haystack for one row. Closed rows carry it already; a live row falls
 * back to what the panel knows, which is everything except the full message text.
 */
function searchTextOf(row: SessionRow): string {
  if (row.searchText) return row.searchText;
  return `${row.sessionId ?? ""} ${row.name} ${row.cwd}`;
}

interface Node {
  kind: "header" | "row";
  section: Section;
  row?: SessionRow;
  id: string;
}

/**
 * Top border with a title on the left and info on the right:
 *   ╭─ Title ───────────────────── info ─╮
 * Both parts are measured in terminal columns, so a CJK title still fits.
 */
function topBorder(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╭";
  const inner = Math.max(0, width - 2);
  const left = `─ ${title} `;
  const right = info ? ` ${info} ─` : "─";
  const fill = Math.max(0, inner - visibleWidth(left) - visibleWidth(right));
  const content = left + "─".repeat(fill) + right;
  const clipped = truncateToWidth(content, inner);
  return "╭" + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + "╮";
}

/** Pad to a column count, not a code-unit count. */
function padEndVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padStartVisible(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

interface Confirmation {
  row: SessionRow;
  confirm: boolean;
}

export class SessionsPanel {
  private readonly options: PanelOptions;
  private selected: string | null = null;
  private query = "";
  private queryCursor = 0;
  private searching = false;
  private confirmation: Confirmation | null = null;
  /** The rename draft and its caret, which the arrows move like any text field. */
  private rename: { row: SessionRow; draft: string; cursor: number } | null = null;
  /** The key list, toggled with ?. */
  private help = false;
  /** First visible row of the key list, for panels too short to show it all. */
  private helpScroll = 0;
  /** Whether the key list is taller than the panel, so the hint can say j/k scrolls. */
  private helpOverflow = false;
  /**
   * Bumped by anything the panel itself changes about a row.
   *
   * The data fingerprint samples rows, and a rename can change a name without
   * changing any number it samples (two names of equal length, or a row past the
   * sample window). A counter the panel controls makes those edits visible
   * exactly, with no extra work per frame. See docs/adr/0012.
   */
  private revision = 0;
  private windowStart = 0;
  private error: string | null = null;
  private pendingG = false;
  private gTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PanelOptions) {
    this.options = options;
  }

  /**
   * Rows after the search filter, grouped into the three sections in order.
   *
   * The haystack and the matching rules are pi -r's, so the same query finds the
   * same sessions in both places.
   */
  private grouped(): Map<Section, SessionRow[]> {
    const rows = this.rowsForFrame();
    const groups = new Map<Section, SessionRow[]>(SECTIONS.map((s) => [s, []]));
    const parsed = parseSearch(this.query);
    if (parsed.error) return groups;
    for (const row of rows) {
      if (parsed.tokens.length > 0 || parsed.mode === "regex") {
        if (!matchSearch(searchTextOf(row), parsed).matches) continue;
      }
      groups.get(row.state)!.push(row);
    }
    return groups;
  }

  /** The flat, selectable projection of the grouped rows. */
  nodes(): Node[] {
    const groups = this.grouped();
    const nodes: Node[] = [];
    for (const section of SECTIONS) {
      const rows = groups.get(section)!;
      if (rows.length === 0) continue;
      nodes.push({ kind: "header", section, id: `header:${section}` });
      for (const row of rows) nodes.push({ kind: "row", section, row, id: row.key });
    }
    return nodes;
  }

  private selectable(): Node[] {
    return this.nodes().filter((n) => n.kind === "row");
  }

  private selectedRow(): SessionRow | null {
    const node = this.nodes().find((n) => n.id === this.selected);
    return node?.row ?? null;
  }

  /**
   * Keep a selection that still exists; otherwise land on the row that took the
   * old one's place.
   *
   * Falling back to the first row teleported the user to the top of the list when
   * a row moved between sections (exit an idle session and it becomes closed) or
   * was deleted. Remembering the index keeps the eye where it was.
   */
  private clampSelection(): void {
    const rows = this.selectable();
    if (rows.some((n) => n.id === this.selected)) return;
    const at = Math.max(0, Math.min(this.selectedIndex, rows.length - 1));
    this.selected = rows[at]?.id ?? null;
    if (rows.length === 0) this.windowStart = 0;
  }

  /** The index the selection had last frame, so a lost selection can be re-anchored. */
  private selectedIndex = 0;

  /** Recompute the remembered index from the current row set. */
  private rememberSelection(): void {
    const at = this.selectable().findIndex((n) => n.id === this.selected);
    if (at >= 0) this.selectedIndex = at;
  }

  private move(delta: number): void {
    const rows = this.selectable();
    const index = rows.findIndex((n) => n.id === this.selected);
    const next = Math.max(0, Math.min(rows.length - 1, (index < 0 ? 0 : index) + delta));
    this.selected = rows[next]?.id ?? null;
    this.rememberSelection();
  }

  private jumpToEdge(edge: "first" | "last"): void {
    const rows = this.selectable();
    this.selected = (edge === "first" ? rows[0] : rows[rows.length - 1])?.id ?? null;
    this.rememberSelection();
  }

  /** X means three different things. See docs/adr/0002. */
  private async pressX(): Promise<void> {
    const row = this.selectedRow();
    if (!row) return;
    this.error = null;
    try {
      if (row.state === "working") await this.options.actions.interrupt(row);
      else if (row.state === "idle") {
        await this.options.actions.exit(row);
        this.revision++;
      } else this.confirmation = { row, confirm: false };
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async confirm(choice: boolean): Promise<void> {
    const pending = this.confirmation;
    this.confirmation = null;
    if (!pending || !choice) return;
    try {
      await this.options.actions.remove(pending.row);
      // The row is gone; let clampSelection land on its neighbour rather than the
      // top of the list.
      this.revision++;
      this.clampSelection();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * A text field's response to one key, or undefined when the key is not text.
   *
   * The search box and the rename box are the same widget with a different label,
   * so they share this: arrows move the caret, backspace deletes before it, delete
   * deletes at it, home/end jump. Sharing it is what keeps the two from drifting —
   * the rename box had no caret at all, and the search box had no arrow handling.
   */
  private editText(value: string, cursor: number, data: string): { value: string; cursor: number } | undefined {
    // The caret moves over code points, never UTF-16 units: one backspace on an
    // emoji must remove the emoji, not half of its surrogate pair.
    const chars = [...value];
    const before = [...value.slice(0, cursor)].length;
    const splice = (from: number, remove: number, insert = ""): { value: string; cursor: number } => {
      const out = [...chars.slice(0, from), ...(insert ? [insert] : []), ...chars.slice(from + remove)];
      const next = out.join("");
      return { value: next, cursor: [...out.slice(0, from + (insert ? 1 : 0))].join("").length };
    };
    if (matchesKey(data, "left")) return before === 0 ? { value, cursor } : splice(before - 1, 0);
    if (matchesKey(data, "right")) return before >= chars.length ? { value, cursor } : splice(before + 1, 0);
    if (matchesKey(data, "home") || data === "\u0001") return { value, cursor: 0 };
    if (matchesKey(data, "end") || data === "\u0005") return { value, cursor: value.length };
    if (matchesKey(data, "backspace")) return before === 0 ? { value, cursor } : splice(before - 1, 1);
    if (matchesKey(data, "delete")) return before >= chars.length ? { value, cursor } : splice(before, 1);
    // A printable key is inserted at the caret, not appended: the caret is the
    // point the user is looking at, and an edit must land there.
    if (data.length >= 1 && !/^[\u0000-\u001f\u007f]+$/.test(data)) {
      return splice(before, 0, data);
    }
    return undefined;
  }

  /**
   * The key list, and the footer's per-mode hint.
   *
   * Both follow pi's own footers (its keybinding-hints.js): the key token is dim,
   * the action is muted, one space between them, and " · " between hints.
   * Alternatives are joined with "/" and no spaces — "j/k", not "j / k" — because
   * the slash separates alternatives inside one token, it is not punctuation
   * around it.
   *
   * Arrow keys are spelled "up"/"down" rather than the glyphs. The glyphs are one
   * narrow column wide and sit on a different baseline from Latin text, so a row of
   * them reads as damage next to "enter" and "esc"; pi spells them out for the
   * same reason.
   */
  private static readonly KEY_LIST: [string, string][] = [
    ["j/k", "move"],
    ["up/down", "move too"],
    ["gg/G", "first / last"],
    ["enter", "open it"],
    ["X", "interrupt, exit or delete"],
    ["r", "rename"],
    ["/", "search"],
    ["R", "rescan closed"],
    ["?", "this list"],
    ["q/esc", "close"],
  ];

  /** One hint: dim key, muted action. */
  private keyHint(theme: any, key: string, action: string): string {
    return theme.fg("dim", key) + theme.fg("muted", " " + action);
  }

  /** Hints joined the way pi joins its own. */
  private hints(theme: any, parts: [string, string][]): string {
    return parts.map(([key, action]) => this.keyHint(theme, key, action)).join(theme.fg("muted", " · "));
  }

  /**
   * The hint row, which must say what the keys do *in this mode*.
   *
   * A single static line was wrong twice over: it never mentioned r or X, and
   * inside search or rename the arrow keys do not close the panel at all.
   */
  private hint(theme: any): string {
    if (this.help) {
      return this.helpOverflow
        ? this.hints(theme, [["j/k", "scroll"], ["any other key", "close"]])
        : this.keyHint(theme, "any key", "close this list");
    }
    if (this.rename) {
      return this.hints(theme, [["enter", "save"], ["esc", "cancel"], ["left/right", "caret"]]);
    }
    if (this.confirmation) {
      return this.hints(theme, [["j/k", "choose"], ["enter", "confirm"], ["esc", "cancel"]]);
    }
    if (this.searching) {
      return this.hints(theme, [["up/down", "pick"], ["enter", "keep"], ["esc", "clear"]]);
    }
    const parts: [string, string][] = [
      ["j/k", "move"],
      ["enter", "open"],
      ["r", "rename"],
      ["X", "stop"],
      ["/", "search"],
      ["?", "keys"],
    ];
    if (this.query) parts.push(["esc", "clear filter"]);
    return this.hints(theme, parts);
  }

  /** The body of the help screen: one key column, one action column. */
  /**
   * The help screen: one key column, one action column, wrapped into as many
   * columns as the panel can carry.
   *
   * The column count is what makes the list fit a short panel instead of being
   * cut off, and `helpScroll` covers the case where even that is not enough: a
   * panel eight rows tall cannot show ten entries side by side, so the list
   * scrolls instead of lying about how many keys exist.
   */
  private helpBody(theme: any, inner: number, rows: number): string[] {
    const keys = SessionsPanel.KEY_LIST;
    const keyWidth = Math.max(...keys.map(([k]) => visibleWidth(k))) + 2;
    const cell = (key: string, action: string) =>
      theme.fg("dim", padEndVisible(key, keyWidth)) + theme.fg("muted", action);

    // Each column is the key column plus its widest action, plus a gap wide
    // enough that two adjacent cells do not read as one run-on line.
    const widest = Math.max(...keys.map(([k, a]) => keyWidth + visibleWidth(a))) + HELP_GAP;
    const byWidth = Math.max(1, Math.floor(inner / widest));
    const byHeight = Math.ceil(keys.length / Math.max(1, rows));
    const columns = Math.max(1, Math.min(byHeight, byWidth));
    const perColumn = Math.ceil(keys.length / columns);

    // Never scroll past the end: a short last page would look like a bug.
    const maxScroll = Math.max(0, perColumn - rows);
    this.helpScroll = Math.max(0, Math.min(this.helpScroll, maxScroll));
    this.helpOverflow = maxScroll > 0;

    const lines: string[] = [];
    for (let row = this.helpScroll; row < perColumn; row++) {
      const cells: string[] = [];
      for (let col = 0; col < columns; col++) {
        const entry = keys[col * perColumn + row];
        if (entry) cells.push(cell(entry[0], entry[1]));
      }
      if (cells.length === 0) break;
      lines.push(truncateToWidth(cells.join(theme.fg("muted", " ".repeat(HELP_GAP))), inner));
    }
    return lines;
  }

  async handleInput(data: string): Promise<void> {
    // While the key list is open it is the only thing that reacts, and any key
    // closes it: reading the list and then hunting for the same key again would
    // be an extra step for no reason.
    if (this.help) {
      // j/k scroll the list when it does not fit; anything else closes it.
      if (data === "j" || matchesKey(data, "down")) {
        this.helpScroll++;
        return;
      }
      if (data === "k" || matchesKey(data, "up")) {
        this.helpScroll = Math.max(0, this.helpScroll - 1);
        return;
      }
      this.help = false;
      this.helpScroll = 0;
      return;
    }

    if (this.rename) {
      if (matchesKey(data, "escape")) {
        this.rename = null;
        return;
      }
      if (data === "\r" || data === "\n" || matchesKey(data, "return")) {
        const { row, draft } = this.rename;
        const next = draft.trim();
        // An empty name is refused rather than closing the box: a silent no-op
        // looks like the save worked, and the user walks away believing it did.
        if (!next) {
          this.error = "A session needs a name.";
          return;
        }
        this.rename = null;
        if (next === row.name) return;
        try {
          await this.options.actions.rename(row, next);
          // The name is in the row set now, but the data fingerprint samples only
          // numbers. This makes the change visible on the very next frame.
          this.revision++;
        } catch (error) {
          this.error = error instanceof Error ? error.message : String(error);
        }
        return;
      }
      const edited = this.editText(this.rename.draft, this.rename.cursor, data);
      if (edited) {
        this.rename.draft = edited.value;
        this.rename.cursor = edited.cursor;
      }
      return;
    }

    if (this.confirmation) {
      if (matchesKey(data, "escape") || matchesKey(data, "left")) {
        this.confirmation = null;
      } else if (data === "j" || matchesKey(data, "down") || data === "\t" || matchesKey(data, "right")) {
        this.confirmation.confirm = true;
      } else if (data === "k" || matchesKey(data, "up")) {
        this.confirmation.confirm = false;
      } else if (data === "\r" || data === "\n" || matchesKey(data, "return")) {
        await this.confirm(this.confirmation.confirm);
      }
      return;
    }

    if (this.searching) {
      if (matchesKey(data, "escape")) {
        this.query = "";
        this.queryCursor = 0;
        this.searching = false;
        this.selected = null;
        this.clampSelection();
        return;
      }
      if (data === "\r" || data === "\n" || matchesKey(data, "return")) {
        this.searching = false;
        return;
      }
      // The arrows belong to the result list, not to the query: the query is
      // typed, but the thing being chosen is a row. Swallowing them here is what
      // made "search, then pick a result" impossible.
      if (matchesKey(data, "up")) {
        this.move(-1);
        return;
      }
      if (matchesKey(data, "down")) {
        this.move(1);
        return;
      }
      const before = this.query;
      const edited = this.editText(this.query, this.queryCursor, data);
      if (edited) {
        this.query = edited.value;
        this.queryCursor = edited.cursor;
      }
      // Only re-anchor the selection when the result set can actually change.
      if (this.query !== before) {
        this.selected = null;
        this.clampSelection();
      }
      return;
    }

    this.error = null;
    // The selection is normally set by the first render, but a key can arrive
    // before it (the host renders once after the overlay mounts). Clamping here
    // makes every mode work on the first keystroke.
    this.clampSelection();
    const row = this.selectedRow();

    if (data === "q" || matchesKey(data, "escape")) {
      this.options.close();
      return;
    }
    if (data === "j" || matchesKey(data, "down")) {
      this.pendingG = false;
      this.move(1);
      return;
    }
    if (data === "k" || matchesKey(data, "up")) {
      this.pendingG = false;
      this.move(-1);
      return;
    }
    if (data === "g") {
      if (this.pendingG) {
        this.pendingG = false;
        this.gTimer && clearTimeout(this.gTimer);
        this.jumpToEdge("first");
      } else {
        this.pendingG = true;
        this.gTimer && clearTimeout(this.gTimer);
        this.gTimer = setTimeout(() => (this.pendingG = false), 500);
      }
      return;
    }
    if (data === "G") {
      this.jumpToEdge("last");
      return;
    }
    if (data === "R") {
      try {
        await this.options.actions.rescan();
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (data === "/") {
      this.searching = true;
      this.queryCursor = this.query.length;
      return;
    }
    if (data === "?") {
      this.help = true;
      this.helpScroll = 0;
      return;
    }
    if (!row) return;

    if (data === "\r" || data === "\n" || matchesKey(data, "return")) {
      await this.act(() => (row.state === "closed" ? this.options.actions.reopen(row) : this.options.actions.focus(row)));
      return;
    }
    if (data === "X") {
      await this.pressX();
      return;
    }
    if (data === "r") {
      this.rename = { row, draft: row.name, cursor: row.name.length };
      return;
    }
  }

  /** The left-arrow gesture must not steal a key the panel is using as text. */
  isEditingText(): boolean {
    return this.searching || this.rename !== null || this.help || this.confirmation !== null;
  }

  /** The selected row key, for tests. */
  selectedKey(): string | null {
    return this.selected;
  }

  /** The message the panel is showing, for tests. */
  errorText(): string | null {
    return this.error;
  }

  private async act(run: () => void | Promise<void>): Promise<void> {
    try {
      await run();
      this.options.close();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Cached frame. A panel is redrawn on a tick even when nothing about it moved,
   * so the last result is reused until one of these actually changes.
   */
  private frameCache: { key: string; lines: string[] } | null = null;

  /** Rows read for the current frame; cleared whenever a frame is rebuilt. */
  private frameRows: SessionRow[] | null = null;

  /**
   * Everything that can change the rendered lines. Cheap on purpose: a tick that
   * changes nothing must cost microseconds, so this is all integers and a few
   * short strings, never a formatted row.
   */
  private frameKey(theme: any, width: number, height: number, at: number): string {
    return [
      width,
      height,
      theme?.name ?? "",
      theme?.appearance ?? "",
      this.selected ?? "",
      this.query,
      // The caret is visible, so it belongs in the key: moving it must redraw, or
      // the cursor sits still until something else happens to change.
      this.queryCursor,
      this.searching ? 1 : 0,
      this.help ? 1 : 0,
      this.helpScroll,
      this.revision,
      this.rename ? `${this.rename.row.key}:${this.rename.draft}:${this.rename.cursor}` : "",
      this.confirmation ? `${this.confirmation.row.key}:${this.confirmation.confirm}` : "",
      this.error ?? "",
      this.windowStart,
      // Every working row shares one clock, so one glyph covers all of them.
      // Reading the clock here, rather than the row set, is what lets the cache
      // hold a frame still while nothing moves.
      this.workingGlyphs(at),
      // Ages change at most once a second, so a second is the granularity.
      Math.floor(at / 1000),
      this.dataSignature(),
    ].join("\u0000");
  }

  /**
   * The glyph the working rows draw right now, or "" when nothing is working.
   *
   * One glyph for the whole section: the rows are in step, so there is nothing
   * per-row to report. Returning "" when idle keeps the key stable while the
   * panel sits there, which is what the frame cache needs to stay a hit.
   */
  private workingGlyphs(at: number): string {
    const anyWorking = this.rowsForFrame().some((row) => row.state === "working");
    return anyWorking ? spinnerFrame(at) : "";
  }

  /**
   * Rows are rebuilt by the host on every call, which is not free (live rows read
   * their session file). One read per frame is enough, so it is memoised and
   * shared by the key and the renderer.
   */
  private rowsForFrame(): SessionRow[] {
    if (!this.frameRows) this.frameRows = this.options.rows();
    return this.frameRows;
  }

  /**
   * Arithmetic fingerprint of the rows, so data changes invalidate the cache.
   *
   * The closed section is append-only and ordered by age, so its head is where
   * change shows up first; sampling the first few hundred rows catches a new or
   * removed session without walking all of them every frame.
   */
  private dataSignature(): number {
    const rows = this.rowsForFrame();
    const limit = Math.min(rows.length, 300);
    let hash = rows.length;
    for (let i = 0; i < limit; i++) {
      const row = rows[i]!;
      hash = (Math.imul(hash, 31) + row.updatedAt + row.state.length + row.name.length + (row.workingSince ?? 0)) | 0;
    }
    return hash;
  }

  render(theme: any, width: number, height: number): string[] {
    const at = Date.now();
    this.frameRows = null;
    this.innerWidth = Math.max(1, width - 4);
    // Everything the key depends on is settled first. windowStart used to be
    // written inside renderFrame, after the key was taken, so the stored key
    // described the previous scroll position and every scroll cost a second,
    // wasted rebuild. See docs/adr/0012.
    this.clampSelection();
    this.scrollIntoView(height);
    const key = this.frameKey(theme, width, height, at);
    if (this.frameCache?.key === key) return this.frameCache.lines;
    const lines = this.renderFrame(theme, width, height, at);
    this.frameCache = { key, lines };
    return lines;
  }

  /**
   * How many body lines fit, and the wrapped error lines that eat into them.
   *
   * Two lines are the frame's top and bottom, one is the blank line under the top
   * border, one is the hint row. Every row and header is exactly one line, so the
   * budget is arithmetic.
   */
  private bodyBudget(height: number, inner: number): { budget: number; errorLines: string[] } {
    const errorLines = this.error ? wrapTextWithAnsi(this.error, inner).slice(0, 2) : [];
    return { budget: Math.max(1, height - 5 - errorLines.length), errorLines };
  }

  /**
   * The first visible line, chosen so the selection is on screen.
   *
   * Runs before the frame key, so a scroll is part of the frame it describes.
   */
  private scrollIntoView(height: number): void {
    const nodes = this.nodes();
    const { budget } = this.bodyBudget(height, this.innerWidth);
    const found = nodes.findIndex((n) => n.id === this.selected);
    if (found >= 0) {
      if (found < this.windowStart) this.windowStart = found;
      else if (found >= this.windowStart + budget) this.windowStart = found - budget + 1;
    }
    this.windowStart = Math.max(0, Math.min(this.windowStart, Math.max(0, nodes.length - budget)));
  }

  /** Width last passed to render, so scrollIntoView can wrap the error line. */
  private innerWidth = 76;

  private renderFrame(theme: any, width: number, height: number, at: number): string[] {
    const inner = Math.max(1, width - 4);
    const border = (s: string) => theme.fg("accent", s);
    const total = this.nodes().length;
    const groups = this.grouped();
    const liveCount = groups.get("working")!.length + groups.get("idle")!.length;
    const info = `${liveCount} live · ${groups.get("closed")!.length} closed`;

    // The filter stays visible after Enter: a list that is silently filtered is a
    // list whose rows appear to be missing.
    const title = this.help
      ? "Keys"
      : this.rename
        ? "Rename session"
        : this.searching
          ? `Search: ${this.query}`
          : this.query
            ? `Sessions — filter: ${this.query}`
            : "Sessions";

    const top = border(topBorder(title, info, width));
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    const { budget, errorLines } = this.bodyBudget(height, inner);

    let body: string[] = [];
    if (this.help) {
      body = this.helpBody(theme, inner, Math.max(1, height - 5));
    } else if (this.confirmation) {
      const { row, confirm } = this.confirmation;
      body = [
        theme.bold(row.name),
        "",
        ...wrapTextWithAnsi(
          `Delete this session file from disk?\n\n${row.sessionFile ?? row.cwd}\n\nThis cannot be undone.`,
          inner,
        ),
        "",
        `${!confirm ? theme.fg("accent", "❯") : " "} Cancel`,
        `${confirm ? theme.fg("accent", "❯") : " "} Delete`,
      ];
    } else if (this.rename) {
      // The caret is drawn where it actually is. It used to be glued to the end of
      // the draft, so moving left with the arrow keys changed nothing on screen
      // and the next character appeared in the middle of a line that looked whole.
      const { draft, cursor } = this.rename;
      const head = truncateToWidth(draft.slice(0, cursor), Math.max(1, inner - 3), "…", true);
      const tail = truncateToWidth(draft.slice(cursor), Math.max(1, inner - 3 - visibleWidth(head)), "…");
      body = [
        theme.bold(this.rename.row.name),
        "",
        `${theme.fg("accent", "❯")} ${head}${theme.fg("accent", "▌")}${tail}`,
      ];
    } else {
      const nodes = this.nodes();
      const sample = nodes.filter((n) => n.kind === "row").slice(0, 200).map((n) => n.row!);
      const folderWidth = Math.min(
        Math.max(0, ...sample.map((r) => visibleWidth(shortCwd(r.cwd)))),
        Math.max(4, Math.floor(inner * 0.32)),
      );
      const ageWidth = Math.min(
        Math.max(0, ...sample.map((r) => visibleWidth(ageOf(r, at)))),
        Math.max(3, Math.floor(inner * 0.14)),
      );
      const rightWidth = sample.length ? folderWidth + 3 + ageWidth : 0;

      const rows = nodes.slice(this.windowStart, this.windowStart + budget);
      for (const node of rows) {
        if (node.kind === "header") {
          body.push(theme.fg("muted", truncateToWidth(` ${SECTION_TITLE[node.section]}`, inner)));
          continue;
        }
        const row = node.row!;
        const isSelected = node.id === this.selected;
        const folder = truncateToWidth(shortCwd(row.cwd), folderWidth, "…");
        const age = truncateToWidth(ageOf(row, at), ageWidth, "…");
        const right = padEndVisible(folder, folderWidth) + "  " + padStartVisible(age, ageWidth) + " ";
        const pointer = isSelected ? theme.fg("accent", "❯") : " ";
        const glyph =
          row.state === "working"
            ? theme.fg("accent", spinnerFrame(at))
            : theme.fg(row.state === "idle" ? "muted" : "dim", STATE_GLYPH[row.state]);
        const nameColor = isSelected ? "accent" : row.state === "closed" ? "muted" : "text";
        const left = `${pointer} ${glyph} ${theme.fg(nameColor, row.name)}`;
        const clippedLeft = truncateToWidth(left, Math.max(1, inner - rightWidth - 2));
        body.push(
          clippedLeft +
            " ".repeat(Math.max(2, inner - visibleWidth(clippedLeft) - rightWidth)) +
            theme.fg("dim", right),
        );
      }
      if (total === 0) body = [theme.fg("dim", this.emptyMessage())];
    }

    body.push(...errorLines.map((s) => theme.fg("error", s)));

    // Never pad past the budget: a wrapped path in the confirmation screen used to
    // push the frame past the overlay's max height.
    if (body.length > Math.max(1, height - 5)) body = body.slice(0, Math.max(1, height - 5));
    while (body.length < Math.max(1, height - 5)) body.push("");

    const hint = truncateToWidth(this.hint(theme), inner);
    const framed = [
      top,
      border("│") + " ".repeat(Math.max(0, width - 2)) + border("│"),
      ...body.map((line) => border("│") + " " + padEndVisible(truncateToWidth(line, inner), inner) + " " + border("│")),
      border("│") + " " + hint + " ".repeat(Math.max(0, inner - visibleWidth(hint))) + " " + border("│"),
      bottom,
    ];

    return framed.map((line) => padEndVisible(truncateToWidth(line, width), width));
  }

  /** Why the list is empty, told apart so a bad regex is not reported as no match. */
  private emptyMessage(): string {
    if (this.query) {
      const parsed = parseSearch(this.query);
      if (parsed.error) return `Search error: ${parsed.error}`;
      return "No session matches this search.";
    }
    return "No sessions.";
  }

  /**
   * Whether a redraw right now would change anything.
   *
   * The spinner steps every ~167ms, but the host polls faster than that. Asking
   * the real frame key is exact: it also catches a second rolling over, the data
   * changing, or a selection moving, none of which a glyph comparison would see.
   */
  needsRedraw(theme: any, width: number, height: number): boolean {
    this.frameRows = null;
    this.clampSelection();
    return this.frameKey(theme, width, height, Date.now()) !== this.frameCache?.key;
  }

  dispose(): void {
    if (this.gTimer) clearTimeout(this.gTimer);
    this.gTimer = null;
  }
}
