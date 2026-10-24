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
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

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

/**
 * Stable per-session offset into the spinner cycle. Claude Code drives a single
 * spinner from one clock; several sessions must not march in lockstep, so each
 * one enters the same two-second cycle at its own fixed point.
 */
function rowPhase(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % SPINNER_PERIOD_MS;
}

/** Claude Code's `qLe`: the cosine easing shared by the spinner and the glow. */
function cosineEase(elapsed: number, period: number): number {
  return (1 - Math.cos((2 * Math.PI * elapsed) / period)) / 2;
}

/** Claude Code's `Zn`: quantise the eased value onto the frame ladder. */
/** Exported for tests: the glyph at a given time, ignoring per-row phase. */
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
  private searching = false;
  private confirmation: Confirmation | null = null;
  private rename: { row: SessionRow; draft: string } | null = null;
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

  private clampSelection(): void {
    const rows = this.selectable();
    if (rows.some((n) => n.id === this.selected)) return;
    this.selected = rows[0]?.id ?? null;
    this.windowStart = 0;
  }

  private move(delta: number): void {
    const rows = this.selectable();
    const index = rows.findIndex((n) => n.id === this.selected);
    const next = Math.max(0, Math.min(rows.length - 1, (index < 0 ? 0 : index) + delta));
    this.selected = rows[next]?.id ?? null;
  }

  private jumpToEdge(edge: "first" | "last"): void {
    const rows = this.selectable();
    this.selected = (edge === "first" ? rows[0] : rows[rows.length - 1])?.id ?? null;
  }

  /** X means three different things. See docs/adr/0002. */
  private async pressX(): Promise<void> {
    const row = this.selectedRow();
    if (!row) return;
    this.error = null;
    try {
      if (row.state === "working") await this.options.actions.interrupt(row);
      else if (row.state === "idle") await this.options.actions.exit(row);
      else this.confirmation = { row, confirm: false };
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
      this.selected = null;
      this.clampSelection();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  async handleInput(data: string): Promise<void> {
    if (this.rename) {
      if (matchesKey(data, "escape")) {
        this.rename = null;
        return;
      }
      if (data === "\r" || data === "\n" || matchesKey(data, "return")) {
        const { row, draft } = this.rename;
        this.rename = null;
        const next = draft.trim();
        if (!next || next === row.name) return;
        try {
          await this.options.actions.rename(row, next);
        } catch (error) {
          this.error = error instanceof Error ? error.message : String(error);
        }
        return;
      }
      if (matchesKey(data, "backspace")) {
        this.rename!.draft = this.rename!.draft.slice(0, -1);
        return;
      }
      if (data.length === 1 && data >= " ") this.rename!.draft += data;
      return;
    }

    if (this.confirmation) {
      if (matchesKey(data, "escape")) {
        this.confirmation = null;
      } else if (data === "j" || matchesKey(data, "down")) {
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
        this.searching = false;
        this.selected = null;
        this.clampSelection();
        return;
      }
      if (data === "\r" || data === "\n" || matchesKey(data, "return")) {
        this.searching = false;
        return;
      }
      if (matchesKey(data, "backspace")) {
        this.query = this.query.slice(0, -1);
      } else if (data.length === 1 && data >= " ") {
        this.query += data;
      }
      this.selected = null;
      this.clampSelection();
      return;
    }

    this.error = null;
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
      this.rename = { row, draft: row.name };
      return;
    }
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
      this.searching ? 1 : 0,
      this.rename ? `${this.rename.row.key}:${this.rename.draft}` : "",
      this.confirmation ? `${this.confirmation.row.key}:${this.confirmation.confirm}` : "",
      this.error ?? "",
      this.windowStart,
      // Every working row animates on its own phase, so the key has to cover all
      // of them. Using one fixed phase here made the key describe a frame that was
      // never drawn, and the cache then suppressed the animation entirely.
      this.workingGlyphs(at),
      // Ages change at most once a second, so a second is the granularity.
      Math.floor(at / 1000),
      this.dataSignature(),
    ].join("\u0000");
  }

  /** The glyph each working row would draw right now, in row order. */
  private workingGlyphs(at: number): string {
    let out = "";
    for (const row of this.rowsForFrame()) {
      if (row.state === "working") out += spinnerFrame(at + rowPhase(row.key));
    }
    return out;
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
    // Clamp before keying: clamping can change the selection, and a key computed
    // from the pre-clamp state describes a frame that is never drawn.
    this.clampSelection();
    const key = this.frameKey(theme, width, height, at);
    if (this.frameCache?.key === key) return this.frameCache.lines;
    const lines = this.renderFrame(theme, width, height, at);
    this.frameCache = { key, lines };
    return lines;
  }

  private renderFrame(theme: any, width: number, height: number, at: number): string[] {
    const inner = Math.max(1, width - 4);
    const border = (s: string) => theme.fg("accent", s);
    const total = this.nodes().length;
    const groups = this.grouped();
    const liveCount = groups.get("working")!.length + groups.get("idle")!.length;
    const info = `${liveCount} live · ${groups.get("closed")!.length} closed`;

    const title = this.rename
      ? "Rename session"
      : this.searching
        ? `Search: ${this.query || "…"}`
        : "Sessions";

    // Counts live on the top border, right aligned, so the body stays clean.
    const top = border(topBorder(title, info, width));
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");

    let body: string[] = [];
    if (this.confirmation) {
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
      body = [
        theme.bold(this.rename.row.name),
        "",
        `${theme.fg("accent", "❯")} ${this.rename.draft}${theme.fg("accent", "▌")}`,
        "",
        theme.fg("dim", "enter saves · esc cancels"),
      ];
    } else {
      // Column widths need every row, but strings only need the visible ones.
      // Measuring is cheap (two small numbers per row); formatting is not.
      const nodes = this.nodes();
      // Column widths are clamped anyway, so a sample is enough. Measuring all
      // 1165 closed rows cost 0.6ms per rebuild for no visible benefit.
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

      // Only the window is drawn, so only the window is formatted. Formatting all
      // 1165 closed rows cost 3.5k truncate calls per rebuild for nothing.
      const extra = this.error
        ? wrapTextWithAnsi(this.error, inner).slice(0, 2).map((s) => theme.fg("error", s))
        : [];
      // One row is reserved for the status footer inside the frame.
      const available = Math.max(1, height - 5);
      const budget = Math.max(1, available - extra.length);

      // Every row and header occupies exactly one line, so the window is arithmetic.
      const found = nodes.findIndex((n) => n.id === this.selected);
      let start = found < 0 ? 0 : Math.max(0, Math.min(this.windowStart, found));
      if (found >= 0) start = Math.max(start, found - budget + 1);
      if (found >= 0 && found < start) start = found;
      this.windowStart = start;

      const rows = nodes.slice(start, start + budget);
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
            ? theme.fg("accent", spinnerFrame(at + rowPhase(row.key)))
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
      if (total === 0) body = [theme.fg("dim", this.query ? "No session matches this search." : "No sessions.")];
      body.push(...extra);
    }

    while (body.length < Math.max(1, height - 5)) body.push("");

    const hint = truncateToWidth("← again to close  ·  R rescan  ·  / search", inner);
    const framed = [
      top,
      border("│") + " ".repeat(Math.max(0, width - 2)) + border("│"),
      ...body.map((line) => border("│") + " " + padEndVisible(truncateToWidth(line, inner), inner) + " " + border("│")),
      border("│") + " " + theme.fg("dim", hint) + " ".repeat(Math.max(0, inner - visibleWidth(hint))) + " " + border("│"),
      bottom,
    ];

    return framed.map((line) => padEndVisible(truncateToWidth(line, width), width));
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
