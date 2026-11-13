import { decodeKittyPrintable, Input, isKeyRepeat, matchesKey, truncateToWidth as truncateGraphemes, visibleWidth, wrapTextWithAnsi, type KeyId } from "@earendil-works/pi-tui";
import { sameRows, type SessionRow, type SessionState } from "./types.ts";
import { formatAge, formatElapsed, shortCwd } from "./format.ts";
import { matchSearch, parseSearch } from "./search.ts";

/** Avoid grapheme segmentation for text that already fits. */
function truncateToWidth(text: string, width: number, ellipsis = "", keepTail = false): string {
  if (visibleWidth(text) <= width) return text;
  return truncateGraphemes(text, width, ellipsis, keepTail);
}

export interface PanelActions {
  /** Generate an editable rename draft; never save it automatically. */
  generateName?(row: SessionRow, signal: AbortSignal): Promise<string>;
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
  /** Immutable sources can skip the full comparison until this revision changes. */
  rowsVersion?(): number;
  actions: PanelActions;
  /** Called when an action means "you left the panel". */
  close(): void;
}

/** Gap between two help columns: wide enough that they read as separate. */
const HELP_GAP = 4;

type Section = SessionState;
const SECTIONS: Section[] = ["working", "idle", "closed"];

/** The working glyph, following Claude Code 2.1.304. */
const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"] as const;
export function spinnerGlyphAt(elapsed: number): string {
  const eased = (1 - Math.cos(2 * Math.PI * elapsed / 2000)) / 2;
  return SPINNER_FRAMES[Math.round(eased * (SPINNER_FRAMES.length - 1))]!;
}

/** Age shown on the right of a row. Working counts to the second, the rest coarsely. */
function ageOf(row: SessionRow, at = Date.now()): string {
  return row.state === "working"
    ? formatElapsed(at - (row.workingSince ?? row.updatedAt))
    : formatAge(row.updatedAt, at);
}

interface Node {
  kind: "header" | "row";
  section: Section;
  row?: SessionRow;
  id: string;
  position: number;
  index: number;
}

/** Fit both labels inside the border in terminal columns. */
function topBorder(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╭";
  const inner = Math.max(0, width - 2);
  const left = `─ ${title} `;
  const right = info ? ` ${info} ─` : "─";
  const fill = Math.max(0, inner - visibleWidth(left) - visibleWidth(right));
  const content = left + "─".repeat(fill) + right;
  return "╭" + padEndVisible(truncateToWidth(content, inner), inner) + "╮";
}

/** Pad to a column count, not a code-unit count. */
function padEndVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function createInput(value = "", prompt = "❯ "): Input {
  const input = new Input({ prompt });
  input.focused = true;
  input.setValue(value);
  input.handleInput("\x05"); // Start editing at the end using Input's public API.
  return input;
}

/** Uppercase aliases keep the displayed shortcuts while matching typed shift keys. */
type PanelKey = KeyId | "G" | "R";

interface PanelCommand {
  keys: PanelKey[];
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

function bindingMatches(data: string, key: PanelKey): boolean {
  const keyId: KeyId = key === "G" ? "shift+g" : key === "R" ? "shift+r" : key;
  return (key.length === 1 && (data === key || decodeKittyPrintable(data) === key)) ||
    (key === "return" && (data === "\r" || data === "\n")) ||
    matchesKey(data, keyId);
}

interface Confirmation {
  row: SessionRow;
}

export class SessionsPanel {
  private readonly options: PanelOptions;
  private selected: string | null = null;
  private query = "";
  private searchInput = createInput();
  private searching = false;
  private confirmation: Confirmation | null = null;
  /** The rename draft and its caret, which the arrows move like any text field. */
  private rename: { row: SessionRow; input: Input; generation?: AbortController } | null = null;
  private help = false;
  /** First visible row of the key list, for panels too short to show it all. */
  private helpScroll = 0;
  /** Whether the key list is taller than the panel, so the hint can say j/k scrolls. */
  private helpOverflow = false;
  private revision = 0;
  private windowStart = 0;
  private error: string | null = null;
  private pendingG = false;
  private gTimer: ReturnType<typeof setTimeout> | null = null;
  private busy: string | null = null;
  private disposed = false;
  private pageSize = 10;
  private pasting = false;
  private sourceRows: SessionRow[] = [];
  private sourceVersion: number | undefined;
  private orderedRows: SessionRow[] = [];
  private projection: { query: string; nodes: Node[]; rows: Node[]; byId: Map<string, Node>; groups: Map<Section, SessionRow[]> } | null = null;
  private dataRevision = 0;

  constructor(options: PanelOptions) {
    this.options = options;
  }

  /** Rows after the search filter, grouped into the three sections in order. */
  private view() {
    if (this.projection?.query === this.query) return this.projection;
    const groups = new Map<Section, SessionRow[]>(SECTIONS.map(s => [s, []]));
    const parsed = parseSearch(this.query);
    if (!parsed.error) for (const row of this.orderedRows) {
      if (!this.query || matchSearch(row.searchText || [row.sessionId ?? "", row.name, row.cwd].join(" "), parsed).matches) groups.get(row.state)!.push(row);
    }
    const nodes: Node[] = [];
    const rows: Node[] = [];
    for (const section of SECTIONS) {
      if (groups.get(section)!.length) nodes.push({ kind: "header", section, id: "header:" + section, position: nodes.length, index: -1 });
      for (const row of groups.get(section)!) {
        const node: Node = { kind: "row", section, row, id: row.key, position: nodes.length, index: rows.length };
        nodes.push(node);
        rows.push(node);
      }
    }
    return this.projection = { query: this.query, nodes, rows, byId: new Map(nodes.map(n => [n.id, n])), groups };
  }

  nodes(): Node[] { return this.view().nodes; }
  private selectable(): Node[] { return this.view().rows; }
  private selectedRow(): SessionRow | null { return this.view().byId.get(this.selected ?? "")?.row ?? null; }

  /** Keep selection stable; a removed row yields to its nearest neighbour. */
  private clampSelection(): void {
    const { rows, byId } = this.view();
    const node = byId.get(this.selected ?? "") ?? (this.selected === null && !this.query ? rows.find(n => n.row?.current) : undefined);
    this.select(node?.index ?? this.selectedIndex);
    if (!rows.length) this.windowStart = 0;
  }

  private selectedIndex = 0;

  private select(index: number): void {
    const rows = this.selectable();
    this.selectedIndex = Math.max(0, Math.min(rows.length - 1, index));
    this.selected = rows[this.selectedIndex]?.id ?? null;
  }

  private move(delta: number): void { this.select(this.selectedIndex + delta); }
  private jumpToEdge(edge: "first" | "last"): void { this.select(edge === "first" ? 0 : this.selectable().length - 1); }

  private page(direction: -1 | 1): void {
    const nodes = this.nodes();
    const rows = this.selectable();
    if (!rows.length) return;
    const current = this.view().byId.get(this.selected ?? "")?.position ?? 0;
    const target = current + direction * this.pageSize;
    const index = direction > 0 ? rows.findIndex(n => n.position >= target) : rows.findLastIndex(n => n.position <= target);
    this.select(index < 0 ? (direction > 0 ? rows.length - 1 : 0) : index);
    this.windowStart = Math.max(0, Math.min(this.windowStart + direction * this.pageSize, nodes.length - this.pageSize));
  }

  private async open(row: SessionRow): Promise<void> {
    if (await this.attempt(() => (row.state === "closed" ? this.options.actions.reopen(row) : this.options.actions.focus(row)))) {
      this.searching = false;
      this.options.close();
    }
  }

  /** x means three different things. See docs/adr/0002. */
  private async pressX(): Promise<void> {
    const row = this.selectedRow();
    if (!row) return;
    await this.attempt(async () => {
      if (row.state === "working") await this.options.actions.interrupt(row);
      else if (row.state === "idle") await this.options.actions.exit(row);
      else this.confirmation = { row };
    });
  }

  private async confirm(choice: boolean): Promise<void> {
    const pending = this.confirmation;
    this.confirmation = null;
    if (pending && choice) await this.attempt(() => this.options.actions.remove(pending.row));
    this.refreshRows();
    this.clampSelection();
  }

  /** One registry drives dispatch, help and mode-specific footer hints. */
  private commands(helpControls = true): PanelCommand[] {
    const command = (keys: PanelKey[], action: string, run: PanelCommand["run"], footer: boolean | number = true, label?: string, primaryKeys?: number): PanelCommand =>
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
      ...(this.options.actions.generateName ? [command(["ctrl+g"], "generate", () => { void this.generateRename(); })] : []),
      command(["escape"], "cancel", () => { this.rename?.generation?.abort(); this.rename = null; this.error = null; }),
      command(["left", "right"], "caret", (data) => this.editInput(data)),
      command(["home", "end"], "first / last character", (data) => this.editInput(data), false),
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
        command(["r"], "rename", () => { this.rename = { row, input: createInput(row.name, "") }; }, false),
        command(["x"], row.state === "working" ? "interrupt" : row.state === "idle" ? "exit" : "delete", () => this.pressX(), false),
      ] : []),
      command(["/"], "search", () => { this.searching = true; this.searchInput = createInput(this.query); }, 50),
      command(["R"], "rescan closed", async () => {
        await this.attempt(() => this.options.actions.rescan());
      }, false),
      command(["?"], "keys", () => { this.help = true; this.helpScroll = 0; }, 20),
      ...(this.query ? [command(["escape"], "clear filter", clearSearch, 10)] : []),
      command(this.query ? ["left", "q"] : ["escape", "left", "q"], "close", (data) => {
        if (!isKeyRepeat(data)) this.options.close();
      }, 10, undefined, 2),
    ];
  }

  private keyHint(theme: any, key: string, action: string): string {
    return theme.fg("dim", key) + theme.fg("muted", " " + action);
  }

  private hint(theme: any, width: number): string {
    if (this.rename?.generation) return truncateToWidth(theme.fg("muted", "Generating name… · ") + this.keyHint(theme, "esc", "cancel"), width);
    if (this.busy) return truncateToWidth(theme.fg("muted", `${this.busy}…`), width);
    if (this.confirmation) {
      const full = "x again to delete permanently";
      const action = width >= full.length + 13 ? full : "x delete";
      const separator = width >= action.length + 13 ? " · " : "  ";
      return truncateToWidth(theme.fg("error", action) + theme.fg("muted", separator) + this.keyHint(theme, "esc", "cancel"), width);
    }
    const parts: string[] = [];
    const separator = theme.fg("muted", " · ");
    let used = 0;
    const commands = this.commands().filter(command => command.footer)
      .sort((a, b) => (typeof a.footer === "number" ? a.footer : 50) - (typeof b.footer === "number" ? b.footer : 50));
    for (const command of commands) {
      const gap = parts.length ? 3 : 0;
      let part = this.keyHint(theme, commandKey(command, true), command.action);
      if (used + gap + visibleWidth(part) > width && command.keys.length > 1) {
        part = this.keyHint(theme, KEY_LABELS[command.keys[0]!] ?? command.keys[0]!, command.action);
      }
      const size = visibleWidth(part);
      if (used + gap + size <= width) { parts.push(part); used += gap + size; }
    }
    return parts.join(separator);
  }

  /** Fit help into columns, then scroll if the terminal is still too short. */
  private helpBody(theme: any, inner: number, rows: number): string[] {
    const keys = this.commands(false).map((command): [string, string] => [commandKey(command), command.action]);
    const keyWidth = Math.max(...keys.map(([k]) => visibleWidth(k))) + 2;
    const cell = (key: string, action: string) =>
      theme.fg("dim", padEndVisible(key, keyWidth)) + theme.fg("muted", action);

    // Separate columns by their widest cell plus a fixed gap.
    const widest = Math.max(...keys.map(([k, a]) => keyWidth + visibleWidth(a))) + HELP_GAP;
    const byWidth = Math.max(1, Math.floor(inner / widest));
    const byHeight = Math.ceil(keys.length / Math.max(1, rows));
    const columns = Math.max(1, Math.min(byHeight, byWidth));
    const perColumn = Math.ceil(keys.length / columns);

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
    if (await this.attempt(() => next === row.name ? undefined : this.options.actions.rename(row, next))) this.rename = null;
  }

  private async generateRename(): Promise<void> {
    // Unlike saving, generation must not set busy: Esc needs to stay usable.
    const edit = this.rename;
    if (!edit || edit.generation || !this.options.actions.generateName) return;
    const controller = new AbortController();
    edit.generation = controller;
    this.error = null;
    this.revision++;
    try {
      const title = await this.options.actions.generateName(edit.row, controller.signal);
      if (this.disposed || this.rename !== edit || controller.signal.aborted) return;
      edit.input = createInput(title, "");
    } catch (error) {
      if (!controller.signal.aborted && this.rename === edit && !this.disposed) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      delete edit.generation;
      this.revision++;
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
    if (!this.rename && !this.searching && bindingMatches(data, "x") && isKeyRepeat(data)) return;
    if (this.rename?.generation && !matchesKey(data, "escape")) return;
    const editing = this.rename;
    this.refreshRows();
    if (editing && !this.rename) return;
    if (this.confirmation) {
      if (isKeyRepeat(data)) return;
      const target = this.confirmation.row;
      const current = this.selectedRow();
      const valid = current?.key === target.key && current.state === "closed" && current.sessionFile === target.sessionFile;
      if (bindingMatches(data, "x")) {
        if (valid) {
          this.busy = "delete";
          try { await this.confirm(true); }
          finally { this.busy = null; this.revision++; }
        } else { this.confirmation = null; this.revision++; }
        return;
      }
      this.confirmation = null;
      this.revision++;
      if (matchesKey(data, "escape")) return;
    }
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
    if (!this.help && !this.rename && !this.searching) {
      if (this.error) { this.error = null; this.revision++; }
      this.clampSelection();
    }
    const command = this.commands().find((command) => command.fallback || command.keys.some(key => bindingMatches(data, key)));
    if (command) {
      this.revision++;
      const pending = command.run(data);
      if (pending) {
        this.busy = command.action;
        try { await pending; }
        finally { this.busy = null; this.refreshRows(); }
      }
    } else if (this.rename || this.searching) this.editInput(data);
  }

  isEditingText(): boolean { return this.searching || this.rename !== null || this.help || this.confirmation !== null; }

  selectedKey(): string | null { return this.selected; }

  errorText(): string | null { return this.error; }

  private async attempt(run: () => void | Promise<void>): Promise<boolean> {
    this.error = null;
    try { await run(); return true; }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); return false; }
    finally { this.revision++; }
  }

  private frameCache: { key: string; theme: unknown; lines: string[] } | null = null;

  /** Snapshot all fields, including action credentials; callers may mutate their rows. */
  private refreshRows(): void {
    const version = this.options.rowsVersion?.();
    if (version !== undefined && version === this.sourceVersion) return;
    const rows = this.options.rows();
    this.sourceVersion = version;
    if (sameRows(rows, this.sourceRows)) return;
    const ranks = new Map(this.orderedRows.map((row, rank) => [row.key, { state: row.state, rank }]));
    this.sourceRows = rows.map(row => ({ ...row, exitControl: row.exitControl && { ...row.exitControl } }));
    const rank = (row: SessionRow) => ranks.get(row.key)?.state === row.state ? ranks.get(row.key)!.rank : Infinity;
    this.orderedRows = [...this.sourceRows].sort((a, b) => SECTIONS.indexOf(a.state) - SECTIONS.indexOf(b.state) || (a.state === "closed" ? 0 : rank(a) - rank(b)));
    if (this.rename) {
      const target = this.sourceRows.find(row => this.rename!.row.sessionFile
        ? row.sessionFile === this.rename!.row.sessionFile : row.key === this.rename!.row.key);
      if (target) { this.rename.row = target; this.selected = target.key; }
      else { this.rename.generation?.abort(); this.rename = null; this.error = "This session is no longer in the list."; }
    }
    this.projection = null;
    this.dataRevision++;
    this.revision++;
  }

  private frameKey(theme: any, width: number, height: number, at: number): string {
    const browsing = !this.help;
    const working = browsing && this.nodes().slice(this.windowStart, this.windowStart + this.pageSize).some(n => n.row?.state === "working");
    return [width, height, theme?.name, theme?.appearance, this.revision,
      browsing ? Math.floor(at / 1000) : "", working ? spinnerGlyphAt(at) : ""].join("\0");
  }

  invalidate(): void { this.frameCache = null; }

  render(theme: any, width: number, height: number): string[] {
    const at = Date.now();
    this.refreshRows();
    this.innerWidth = Math.max(1, width - 4);
    this.pageSize = this.bodyBudget(height, this.innerWidth).budget;
    // Settle selection and scroll before caching the frame.
    this.clampSelection();
    this.scrollIntoView(height);
    const key = this.frameKey(theme, width, height, at);
    if (this.frameCache?.key === key && this.frameCache.theme === theme) return this.frameCache.lines;
    const lines = this.renderFrame(theme, width, height, at);
    this.frameCache = { key, theme, lines };
    return lines;
  }

  /** How many body lines fit, and the wrapped error lines that eat into them. */
  private bodyBudget(height: number, inner: number): { budget: number; errorLines: string[] } {
    const errorLines = this.error ? wrapTextWithAnsi(this.error, inner).slice(0, 2) : [];
    return { budget: Math.max(1, height - 5 - errorLines.length - (this.searching ? 1 : 0)), errorLines };
  }

  private scrollIntoView(height: number): void {
    const nodes = this.nodes();
    const { budget } = this.bodyBudget(height, this.innerWidth);
    const found = this.view().byId.get(this.selected ?? "")?.position ?? -1;
    if (found >= 0) {
      if (found < this.windowStart) this.windowStart = found;
      else if (found >= this.windowStart + budget) this.windowStart = found - budget + 1;
    }
    this.windowStart = Math.max(0, Math.min(this.windowStart, Math.max(0, nodes.length - budget)));
  }

  private innerWidth = 76;

  private columns: { key: string; folderWidth: number; ageWidth: number } | null = null;

  private renderFrame(theme: any, width: number, height: number, at: number): string[] {
    const inner = Math.max(1, width - 4);
    const border = (s: string) => theme.fg("borderMuted", s);
    const total = this.nodes().length;
    const groups = this.view().groups;
    const liveCount = groups.get("working")!.length + groups.get("idle")!.length;
    const info = `${liveCount} live · ${groups.get("closed")!.length} closed`;

    // The filter stays visible after Enter: a list that is silently filtered is a
    // list whose rows appear to be missing.
    const title = this.help
      ? "Keys"
      : this.searching
          ? "Search"
          : this.query
            ? `Sessions — filter: ${this.query}`
            : "Sessions";

    const top = border(topBorder(title, info, width));
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    const { budget, errorLines } = this.bodyBudget(height, inner);
    const browsing = !this.help;
    const hasAbove = browsing && this.windowStart > 0;
    const hasBelow = browsing && this.windowStart + budget < total;

    let body: string[] = [];
    if (this.help) {
      body = this.helpBody(theme, inner, Math.max(1, height - 5));
    } else {
      if (this.searching) body.push(this.searchInput.render(inner)[0]!);
      const nodes = this.nodes();
      const columnKey = [inner, this.dataRevision, this.query, Math.floor(at / 1000)].join("\0");
      if (this.columns?.key !== columnKey) {
        const sample = this.selectable().slice(0, 200).map(n => n.row!);
        this.columns = {
          key: columnKey,
          folderWidth: inner >= 68 ? Math.min(Math.max(0, ...sample.map(r => visibleWidth(shortCwd(r.cwd)))), Math.max(4, Math.floor(inner * 0.32))) : 0,
          ageWidth: inner >= 52 ? Math.min(Math.max(0, ...sample.map(r => visibleWidth(ageOf(r, at)))), Math.max(3, Math.floor(inner * 0.14))) : 0,
        };
      }
      const { folderWidth, ageWidth } = this.columns;
      const rightWidth = this.selectable().length && ageWidth ? ageWidth + 1 + (folderWidth ? folderWidth + 2 : 0) : 0;

      const rows = nodes.slice(this.windowStart, this.windowStart + budget);
      for (const node of rows) {
        if (node.kind === "header") {
          const title = node.section[0]!.toUpperCase() + node.section.slice(1);
          body.push(theme.fg("muted", truncateToWidth(" " + title, inner)));
          continue;
        }
        const row = node.row!;
        const isSelected = node.id === this.selected;
        const folder = truncateToWidth(shortCwd(row.cwd), folderWidth, "…");
        const age = truncateToWidth(ageOf(row, at), ageWidth, "…"); // Age labels use one column per code unit.
        const right = rightWidth ? (folderWidth ? padEndVisible(folder, folderWidth) + "  " : "") + age.padStart(ageWidth) + " " : "";
        const glyph = row.state === "working" ? spinnerGlyphAt(at) : row.state === "idle" ? "○" : "·";
        const styledGlyph = theme.fg("muted", glyph);
        const leftWidth = Math.max(1, inner - rightWidth - (rightWidth ? 2 : 0));
        const name = this.rename?.row.key === row.key
          ? this.rename.input.render(Math.max(1, leftWidth - 4))[0]!
          : row.current ? theme.bold(row.name) : row.name;
        const left = isSelected
          ? `❯ ${glyph} ${name}`
          : `  ${styledGlyph} ${theme.fg(row.state === "closed" && !row.current ? "muted" : "text", name)}`;
        const clippedLeft = truncateToWidth(left, leftWidth, "…");
        const line = clippedLeft
          + " ".repeat(Math.max(0, inner - visibleWidth(clippedLeft) - rightWidth))
          + (isSelected ? right : theme.fg("dim", right));
        const background = row.current ? "customMessageBg" : isSelected ? "selectedBg" : undefined;
        body.push(background ? theme.bg(background, theme.fg("text", line)) : line);
      }
      if (total === 0) body.push(theme.fg("dim", this.emptyMessage()));
    }

    body.push(...errorLines.map((s) => theme.fg("error", s)));

    // Wrapped paths and errors must stay within the overlay height.
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

  needsRedraw(theme: any, width: number, height: number): boolean {
    this.refreshRows();
    this.clampSelection();
    return this.frameCache?.theme !== theme || this.frameKey(theme, width, height, Date.now()) !== this.frameCache?.key;
  }

  dispose(): void {
    this.rename?.generation?.abort();
    this.disposed = true;
    if (this.gTimer) clearTimeout(this.gTimer);
    this.gTimer = null;
  }
}
