/**
 * The Sessions panel.
 *
 * One flat list, three stacked sections. Live rows come first because they are
 * the ones you act on; the closed section is long by nature and is the only
 * part that needs real scrolling.
 */
import { decodeKittyPrintable, Input, isKeyRepeat, matchesKey, truncateToWidth as truncateGraphemes, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

const IDENTITY_COLORS = ["syntaxKeyword", "syntaxFunction", "syntaxString", "syntaxNumber", "syntaxType", "syntaxVariable"] as const;

function identityColor(row: SessionRow): typeof IDENTITY_COLORS[number] {
  // The file survives reopening; the process key and title do not.
  const identity = row.sessionFile ?? row.sessionId ?? row.key;
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(identity)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return IDENTITY_COLORS[hash % IDENTITY_COLORS.length]!;
}

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

function createInput(value = ""): Input {
  const input = new Input({ prompt: "❯ " });
  input.focused = true;
  input.setValue(value);
  input.handleInput("\x05"); // Start editing at the end using Input's public API.
  return input;
}

interface PanelCommand {
  keys: string[];
  action: string;
  run(data: string): void | Promise<void>;
  /** True uses normal priority; numbers put primary actions first. */
  footer?: boolean | number;
  primaryKeys?: number;
  label?: string;
  fallback?: boolean;
}

const KEY_LABELS: Record<string, string> = {
  up: "↑", down: "↓", left: "←", right: "→", return: "enter", escape: "esc",
  pageUp: "pgup", pageDown: "pgdn",
};

function commandKey(command: PanelCommand, compact = false): string {
  const keys = compact ? command.keys.slice(0, command.primaryKeys) : command.keys;
  return command.label ?? keys.map((key) => KEY_LABELS[key] ?? key).join("/");
}

function bindingMatches(data: string, key: string): boolean {
  return (key.length === 1 && (data === key || decodeKittyPrintable(data) === key)) ||
    (key === "return" && (data === "\r" || data === "\n")) ||
    matchesKey(data, /^[A-Z]$/.test(key) ? `shift+${key.toLowerCase()}` : key);
}

function commandMatches(command: PanelCommand, data: string): boolean {
  return command.fallback === true || command.keys.some((key) => bindingMatches(data, key));
}

interface Confirmation {
  row: SessionRow;
  confirm: boolean;
}

export class SessionsPanel {
  private readonly options: PanelOptions;
  private selected: string | null = null;
  private query = "";
  private searchInput = createInput();
  private searching = false;
  private confirmation: Confirmation | null = null;
  /** The rename draft and its caret, which the arrows move like any text field. */
  private rename: { row: SessionRow; input: Input } | null = null;
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
  private busy: string | null = null;
  private disposed = false;
  private pageSize = 10;
  private pasting = false;
  private rowOrder = new Map<string, { state: SessionState; rank: number }>();

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
    const selectedIndex = rows.findIndex((n) => n.id === this.selected);
    if (selectedIndex >= 0) {
      this.selectedIndex = selectedIndex;
      return;
    }
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

  private page(direction: -1 | 1): void {
    const nodes = this.nodes();
    const rows = nodes.map((node, position) => ({ node, position })).filter(({ node }) => node.kind === "row");
    if (!rows.length) return;
    const current = nodes.findIndex((node) => node.id === this.selected);
    const target = current + direction * this.pageSize;
    const next = direction > 0
      ? rows.find(({ position }) => position >= target) ?? rows.at(-1)!
      : rows.findLast(({ position }) => position <= target) ?? rows[0]!;
    this.selected = next.node.id;
    this.windowStart = Math.max(0, Math.min(this.windowStart + direction * this.pageSize, nodes.length - this.pageSize));
    this.rememberSelection();
  }

  private async open(row: SessionRow): Promise<void> {
    if (await this.act(() => (row.state === "closed" ? this.options.actions.reopen(row) : this.options.actions.focus(row)))) {
      this.searching = false;
    }
  }

  /** x means three different things. See docs/adr/0002. */
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
      this.frameRows = null;
      this.clampSelection();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** One registry drives dispatch, help and mode-specific footer hints. */
  private commands(helpControls = true): PanelCommand[] {
    const command = (keys: string[], action: string, run: PanelCommand["run"], footer: boolean | number = true, label?: string, primaryKeys?: number): PanelCommand =>
      ({ keys, action, run, footer, label, primaryKeys });
    if (this.help && helpControls) return [
      ...(this.helpOverflow ? [command(["up", "down", "j", "k"], "scroll", (data) => {
        this.helpScroll = Math.max(0, this.helpScroll + (matchesKey(data, "k") || matchesKey(data, "up") ? -1 : 1));
      })] : []),
      { keys: [], label: this.helpOverflow ? "any other key" : "any key", action: "close", footer: true, fallback: true,
        run: () => { this.help = false; this.helpScroll = 0; } },
    ];
    const clearSearch = () => {
      this.query = "";
      this.searchInput = createInput();
      this.searching = false;
      this.clampSelection();
    };
    const open = async () => {
      this.clampSelection();
      const row = this.selectedRow();
      if (row) await this.open(row);
    };
    if (this.rename) return [
      command(["return"], "save", () => this.saveRename()),
      command(["escape"], "cancel", () => { this.rename = null; this.error = null; }),
      command(["left", "right"], "caret", (data) => this.editInput(data)),
      command(["home", "end"], "first / last character", (data) => this.editInput(data), false),
    ];
    if (this.confirmation) return [
      command(["left", "right", "tab", "up", "down", "j", "k"], "choose", (data) => {
        if (matchesKey(data, "tab")) this.confirmation!.confirm = !this.confirmation!.confirm;
        else this.confirmation!.confirm = matchesKey(data, "j") || matchesKey(data, "down") || matchesKey(data, "right");
      }, true, undefined, 3),
      command(["return"], "confirm", () => this.confirm(this.confirmation!.confirm)),
      command(["escape"], "cancel", () => { this.confirmation = null; }),
    ];
    if (this.searching) return [
      command(["up", "down"], "pick", (data) => this.move(matchesKey(data, "up") ? -1 : 1)),
      command(["pageUp", "pageDown"], "page", (data) => this.page(matchesKey(data, "pageUp") ? -1 : 1), false),
      command(["return"], "open", open),
      command(["escape"], "clear", clearSearch),
      command(["left", "right"], "caret", (data) => this.editInput(data), false),
      command(["home", "end"], "first / last character", (data) => this.editInput(data), false),
    ];
    const row = this.selectedRow();
    return [
      ...(row ? [
        command(["up", "down", "j", "k"], "move", (data) => {
          this.pendingG = false;
          this.move(matchesKey(data, "k") || matchesKey(data, "up") ? -1 : 1);
        }, 40, undefined, 2),
        command(["pageUp", "pageDown"], "page", (data) => this.page(matchesKey(data, "pageUp") ? -1 : 1), false),
        command(["home", "end", "g", "G"], "first / last", (data) => {
          if (matchesKey(data, "home")) this.jumpToEdge("first");
          else if (matchesKey(data, "end") || bindingMatches(data, "G")) this.jumpToEdge("last");
          else if (this.pendingG) {
            this.pendingG = false;
            if (this.gTimer) clearTimeout(this.gTimer);
            this.jumpToEdge("first");
          } else {
            this.pendingG = true;
            if (this.gTimer) clearTimeout(this.gTimer);
            this.gTimer = setTimeout(() => (this.pendingG = false), 500);
          }
        }, false, "home/end/gg/G"),
        command(["return", "right"], "open", open, 30),
        command(["r"], "rename", () => { this.rename = { row, input: createInput(row.name) }; }, false),
        command(["x"], row.state === "working" ? "interrupt" : row.state === "idle" ? "exit" : "delete", () => this.pressX(), false),
      ] : []),
      command(["/"], "search", () => { this.searching = true; this.searchInput = createInput(this.query); }, 50),
      command(["R"], "rescan closed", async () => {
        try { await this.options.actions.rescan(); }
        catch (error) { this.error = error instanceof Error ? error.message : String(error); }
      }, false),
      command(["?"], "keys", () => { this.help = true; this.helpScroll = 0; }, 20),
      ...(this.query ? [command(["escape"], "clear filter", clearSearch, 10)] : []),
      command(this.query ? ["left", "q"] : ["escape", "left", "q"], "close", (data) => {
        if (!isKeyRepeat(data)) this.options.close();
      }, 10, undefined, 2),
    ];
  }

  /** One hint: dim key, muted action. */
  private keyHint(theme: any, key: string, action: string): string {
    return theme.fg("dim", key) + theme.fg("muted", " " + action);
  }

  /** Hints joined the way pi joins its own. */
  private hints(theme: any, parts: [string, string][]): string {
    return parts.map(([key, action]) => this.keyHint(theme, key, action)).join(theme.fg("muted", " · "));
  }

  private hint(theme: any, width: number): string {
    if (this.busy) return truncateToWidth(theme.fg("muted", `${this.busy}…`), width);
    const parts: [string, string][] = [];
    const commands = this.commands().filter((command) => command.footer)
      .sort((a, b) => (typeof a.footer === "number" ? a.footer : 50) - (typeof b.footer === "number" ? b.footer : 50));
    for (const command of commands) {
      const part: [string, string] = [commandKey(command, true), command.action];
      if (visibleWidth(this.hints(theme, [...parts, part])) <= width) parts.push(part);
      else if (command.keys.length > 1) {
        part[0] = KEY_LABELS[command.keys[0]!] ?? command.keys[0]!;
        if (visibleWidth(this.hints(theme, [...parts, part])) <= width) parts.push(part);
      }
    }
    return this.hints(theme, parts);
  }

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
    const keys = this.commands(false).map((command): [string, string] => [commandKey(command), command.action]);
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

  private async saveRename(): Promise<void> {
    const { row, input } = this.rename!;
    const next = input.getValue().trim();
    if (!next) { this.error = "A session needs a name."; return; }
    try {
      if (next !== row.name) {
        await this.options.actions.rename(row, next);
        this.revision++;
      }
      this.rename = null;
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private editInput(data: string): void {
    const input = this.rename?.input ?? this.searchInput;
    const before = input.getValue();
    input.handleInput(data);
    this.revision++; // Input owns its caret, undo and paste state.
    if (input.getValue() === before) return;
    this.error = null;
    if (this.searching) {
      this.query = input.getValue();
      this.selected = null;
      this.selectedIndex = 0;
      this.windowStart = 0;
      this.clampSelection();
    }
  }

  async handleInput(data: string): Promise<void> {
    if (this.busy || this.disposed) return;
    this.frameRows = null;
    if ((this.rename || this.searching) && (this.pasting || data.includes("\x1b[200~"))) {
      this.pasting = !data.includes("\x1b[201~");
      this.editInput(data);
      return;
    }
    if (!matchesKey(data, "g")) {
      this.pendingG = false;
      if (this.gTimer) clearTimeout(this.gTimer);
      this.gTimer = null;
    }
    if (!this.help && !this.rename && !this.searching && !this.confirmation) {
      this.error = null;
      this.clampSelection();
    }
    const command = this.commands().find((command) => commandMatches(command, data));
    if (command) {
      const pending = command.run(data);
      if (pending) {
        this.busy = command.action;
        try { await pending; }
        finally { this.busy = null; this.frameRows = null; }
      }
    } else if (this.rename || this.searching) this.editInput(data);
  }

  /** Whether a text field or modal view is active. */
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

  private async act(run: () => void | Promise<void>): Promise<boolean> {
    try {
      await run();
      this.options.close();
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return false;
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
      this.searching ? 1 : 0,
      this.help ? 1 : 0,
      this.helpScroll,
      this.revision, // Also covers Input's private caret and undo state.
      this.rename ? `${this.rename.row.key}:${this.rename.input.getValue()}` : "",
      this.confirmation ? `${this.confirmation.row.key}:${this.confirmation.confirm}` : "",
      this.error ?? "",
      this.busy ?? "",
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
    if (!this.frameRows) {
      const rank = (row: SessionRow): number => {
        const previous = this.rowOrder.get(row.key);
        return previous?.state === row.state ? previous.rank : Number.MAX_SAFE_INTEGER;
      };
      this.frameRows = [...this.options.rows()].sort((a, b) => SECTIONS.indexOf(a.state) - SECTIONS.indexOf(b.state) || rank(a) - rank(b));
      this.rowOrder = new Map(this.frameRows.map((row, rank) => [row.key, { state: row.state, rank }]));
    }
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
    if (this.confirmation) height = Math.min(height, 12);
    const at = Date.now();
    this.frameRows = null;
    this.innerWidth = Math.max(1, width - 4);
    this.pageSize = this.bodyBudget(height, this.innerWidth).budget;
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
    return { budget: Math.max(1, height - 5 - errorLines.length - (this.searching ? 1 : 0)), errorLines };
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

  private confirmationBody(theme: any, inner: number, budget: number): string[] {
    const { row, confirm } = this.confirmation!;
    const button = (label: string, selected: boolean, danger: boolean): string => {
      const text = theme.fg(danger ? "error" : selected ? "text" : "muted", `[${selected ? "❯" : " "} ${label} ]`);
      return selected ? theme.bg("selectedBg", theme.bold(text)) : text;
    };
    const cancel = button("Cancel", !confirm, false);
    const remove = button("Delete", confirm, true);
    const buttons = visibleWidth(cancel + "  " + remove) <= inner ? [cancel + "  " + remove] : [cancel, remove];
    const available = Math.max(0, budget - buttons.length);
    const details: string[] = [];
    if (available) details.push(theme.bold(truncateToWidth(row.name, inner, "…")));
    const warning = available >= 2;
    const pathBudget = Math.min(3, Math.max(0, available - 1 - Number(warning) - Number(available >= 4) - Number(available >= 3)));
    if (pathBudget) {
      const path = wrapTextWithAnsi(row.sessionFile ?? row.cwd, inner);
      const lines = path.slice(0, pathBudget);
      if (path.length > lines.length) lines[lines.length - 1] = truncateToWidth(lines.at(-1)!, Math.max(0, inner - 1)) + "…";
      details.push(...lines.map((line) => theme.fg("dim", line)));
    }
    if (available >= 4) details.push("");
    if (warning) details.push(theme.fg("warning", "! Cannot be undone."));
    if (available >= 3) details.push("");
    return [...details, ...buttons];
  }

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
      : this.confirmation
        ? theme.fg("error", "Delete permanently?")
      : this.rename
        ? "Rename session"
        : this.searching
          ? "Search"
          : this.query
            ? `Sessions — filter: ${this.query}`
            : "Sessions";

    const top = border(topBorder(title, this.confirmation ? "" : info, width));
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    const { budget, errorLines } = this.bodyBudget(height, inner);
    const browsing = !this.help && !this.rename && !this.confirmation;
    const hasAbove = browsing && this.windowStart > 0;
    const hasBelow = browsing && this.windowStart + budget < total;

    let body: string[] = [];
    if (this.help) {
      body = this.helpBody(theme, inner, Math.max(1, height - 5));
    } else if (this.confirmation) {
      body = this.confirmationBody(theme, inner, budget);
    } else if (this.rename) {
      body = this.rename.input.render(inner);
    } else {
      if (this.searching) body.push(this.searchInput.render(inner)[0]!);
      const nodes = this.nodes();
      const sample = nodes.filter((n) => n.kind === "row").slice(0, 200).map((n) => n.row!);
      const folderWidth = inner >= 68 ? Math.min(
        Math.max(0, ...sample.map((r) => visibleWidth(shortCwd(r.cwd)))),
        Math.max(4, Math.floor(inner * 0.32)),
      ) : 0;
      const ageWidth = inner >= 52 ? Math.min(
        Math.max(0, ...sample.map((r) => visibleWidth(ageOf(r, at)))),
        Math.max(3, Math.floor(inner * 0.14)),
      ) : 0;
      const rightWidth = sample.length && ageWidth ? ageWidth + 1 + (folderWidth ? folderWidth + 2 : 0) : 0;

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
        const right = rightWidth ? (folderWidth ? padEndVisible(folder, folderWidth) + "  " : "") + padStartVisible(age, ageWidth) + " " : "";
        const glyph = row.state === "working" ? spinnerFrame(at) : STATE_GLYPH[row.state];
        const styledGlyph = theme.fg(row.state === "working" ? "success" : row.state === "idle" ? "accent" : "dim", glyph);
        const left = isSelected
          ? `❯ ${glyph} ${row.name}`
          : `  ${styledGlyph} ${theme.fg(identityColor(row), row.name)}`;
        const clippedLeft = truncateToWidth(left, Math.max(1, inner - rightWidth - (rightWidth ? 2 : 0)), "…");
        const line = clippedLeft
          + " ".repeat(Math.max(0, inner - visibleWidth(clippedLeft) - rightWidth))
          + (isSelected ? right : theme.fg("dim", right));
        body.push(isSelected ? theme.bg("selectedBg", theme.fg("text", line)) : line);
      }
      if (total === 0) body.push(theme.fg("dim", this.emptyMessage()));
    }

    body.push(...errorLines.map((s) => theme.fg("error", s)));

    // Never pad past the budget: a wrapped path in the confirmation screen used to
    // push the frame past the overlay's max height.
    if (body.length > Math.max(1, height - 5)) body = body.slice(0, Math.max(1, height - 5));
    while (body.length < Math.max(1, height - 5)) body.push("");

    const hintWidth = Math.max(0, inner - (hasBelow ? 2 : 0));
    const hint = padEndVisible(this.hint(theme, hintWidth), hintWidth) + (hasBelow ? theme.fg("muted", " ↓") : "");
    const framed = [
      top,
      border("│") + " " + padEndVisible(hasAbove ? theme.fg("muted", "↑") : "", inner) + " " + border("│"),
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
    if (this.confirmation) height = Math.min(height, 12);
    this.frameRows = null;
    this.clampSelection();
    return this.frameKey(theme, width, height, Date.now()) !== this.frameCache?.key;
  }

  dispose(): void {
    this.disposed = true;
    if (this.gTimer) clearTimeout(this.gTimer);
    this.gTimer = null;
  }
}
