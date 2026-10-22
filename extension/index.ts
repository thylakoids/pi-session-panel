/**
 * pi-session-panel
 *
 * Registers a /sessions command, installs the left-arrow gesture, and keeps this
 * process's own record in the registry while it runs.
 */
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { createGestureEditor } from "./editor.ts";
import { SessionsPanel, currentGlyph } from "./panel.ts";
import { loadClosed, insertClosed, rowFromInfo, type ClosedIndex } from "./closed.ts";
import { ownPane, rowFromRecord } from "./live.ts";
import { readRegistry, registryDir, removeRecord, writeRecord, type RegistryRecord } from "./registry.ts";
import type { SessionRow } from "./types.ts";

/** Run one tmux command, surfacing its stderr as the error message. */
function runTmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8" });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `tmux ${args[0]} failed`);
  }
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const registry = registryDir(agentDir);

  /** This process's own state, mirrored into the registry on every change. */
  const self = {
    pid: process.pid,
    cwd: process.cwd(),
    state: "idle" as RegistryRecord["state"],
    workingSince: undefined as number | undefined,
    updatedAt: Date.now(),
    sessionFile: undefined as string | undefined,
    name: undefined as string | undefined,
    ...ownPane(),
  };

  let ctx: ExtensionContext | undefined;

  const publish = () => {
    self.updatedAt = Date.now();
    try {
      writeRecord(registry, { ...self });
    } catch {
      // A read-only or missing agent dir must not break the session.
    }
  };

  /** Keep the record's session file and name in step with the real session. */
  const syncSession = () => {
    let changed = false;
    const file = ctx?.sessionManager.getSessionFile();
    if (file && file !== self.sessionFile) {
      self.sessionFile = file;
      changed = true;
    }
    const name = ctx?.sessionManager.getSessionName();
    if (name !== self.name) {
      self.name = name;
      changed = true;
    }
    if (changed) publish();
  };

  // ── closed index ────────────────────────────────────────────────────────────
  /** Null until the first async load finishes. */
  let closedIndex: ClosedIndex | null = null;
  let loading = false;

  const ensureClosedLoaded = (context: ExtensionContext) => {
    if (closedIndex || loading) return;
    loading = true;
    const dir = context.sessionManager.getSessionDir();
    void loadClosed(dir)
      .then((rows) => {
        closedIndex = { rows, loadedAt: Date.now() };
      })
      .catch(() => {
        // Leave it null; the next panel open retries.
      })
      .finally(() => {
        loading = false;
      });
  };

  /** Rescan on demand (the R key). */
  const rescan = async (context: ExtensionContext): Promise<void> => {
    const dir = context.sessionManager.getSessionDir();
    closedIndex = { rows: await loadClosed(dir), loadedAt: Date.now() };
  };

  // ── rows ────────────────────────────────────────────────────────────────────
  const rows = (): SessionRow[] => {
    const { live } = readRegistry(registry);
    const liveRows = live.map(rowFromRecord);
    return [...liveRows, ...(closedIndex?.rows ?? [])];
  };

  // ── panel ───────────────────────────────────────────────────────────────────
  let panelOpen = false;

  async function openPanel(context: ExtensionContext): Promise<void> {
    if (panelOpen) return;
    if (context.mode !== "tui") {
      context.ui.notify("The sessions panel needs interactive mode.", "warning");
      return;
    }
    ensureClosedLoaded(context);
    panelOpen = true;

    try {
      await context.ui.custom(
        (tui: any, theme: any, _bindings: any, done: (value?: unknown) => void) => {
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            panel.dispose();
            done(undefined);
          };

          const panel = new SessionsPanel({
            rows,
            close,
            notify: (message, type) => context.ui.notify(message, type),
            actions: {
              focus: (row) => focusPane(row, context),
              adopt: (row) => adopt(row, context, close),
              interrupt: (row) => interrupt(row),
              exit: (row) => exit(row, context),
              remove: (row) => removeSession(row),
              rename: (row, next) => rename(row, next),
            },
          });

          // Only redraw when the spinner actually steps.
          let lastGlyph = "";
          const timer = setInterval(() => {
            const glyph = currentGlyph();
            if (glyph === lastGlyph) return;
            lastGlyph = glyph;
            tui.requestRender();
          }, 50);

          return {
            invalidate() {},
            render: (columns: number) => panel.render(theme, columns, Math.max(8, Math.min(40, Math.floor((tui.terminal?.rows ?? 40) * 0.85)))),
            handleInput: (data: string) => {
              if (matchesKey(data, "left")) {
                close();
                tui.requestRender();
                return;
              }
              const pending = panel.handleInput(data);
              tui.requestRender();
              void pending.finally(() => tui.requestRender());
            },
            dispose: () => {
              clearInterval(timer);
              panel.dispose();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: () => ({
            anchor: "center",
            width: Math.max(1, Math.min(112, Math.floor((process.stdout.columns ?? 100) * 0.92))),
            maxHeight: "85%",
            margin: 1,
          }),
        },
      );
    } finally {
      panelOpen = false;
    }
  }

  // ── actions ─────────────────────────────────────────────────────────────────
  const focusPane = (row: SessionRow, context: ExtensionContext) => {
    if (!row.pane) throw new Error("This session is not in tmux.");
    runTmux(["select-window", "-t", row.pane]);
    runTmux(["select-pane", "-t", row.pane]);
  };

  const adopt = async (row: SessionRow, context: ExtensionContext, close: () => void) => {
    if (!row.sessionFile) throw new Error("This session has no file to open.");
    const command = context as Partial<ExtensionCommandContext>;
    if (typeof command.switchSession !== "function") {
      throw new Error("Switching sessions needs a command context; open the panel with /sessions.");
    }
    close();
    await command.switchSession(row.sessionFile);
  };

  /** Working rows: send Escape, which is what the user would press. */
  const interrupt = (row: SessionRow) => {
    if (!row.pane) throw new Error("This session is not in tmux, so it cannot be interrupted.");
    runTmux(["send-keys", "-t", row.pane, "Escape"]);
  };

  /** Idle rows: ask the process to exit. */
  const exit = (row: SessionRow, context: ExtensionContext) => {
    const pid = Number(row.key.replace("live:", ""));
    if (!Number.isInteger(pid)) throw new Error("This session has no process to stop.");
    process.kill(pid, "SIGTERM");
    // The row lands in Closed straight away, without rescanning the disk.
    if (closedIndex) {
      closedIndex = insertClosed(closedIndex, {
        ...row,
        state: "closed",
        key: `closed:${row.sessionFile ?? row.key}`,
        updatedAt: Date.now(),
        workingSince: undefined,
        pane: undefined,
      });
    }
  };

  const removeSession = async (row: SessionRow) => {
    if (!row.sessionFile) throw new Error("This session has no file to delete.");
    await rm(row.sessionFile, { force: true });
    if (closedIndex) {
      closedIndex = { ...closedIndex, rows: closedIndex.rows.filter((r) => r.key !== row.key) };
    }
  };

  const rename = async (row: SessionRow, next: string) => {
    if (!row.sessionFile) throw new Error("This session has no file to name.");
    const manager = SessionManager.open(row.sessionFile);
    manager.appendSessionInfo(next);
    if (closedIndex) {
      closedIndex = { ...closedIndex, rows: closedIndex.rows.map((r) => (r.key === row.key ? { ...r, name: next } : r)) };
    }
  };

  // ── wiring ──────────────────────────────────────────────────────────────────
  pi.registerCommand("sessions", {
    description: "Manage every running and closed pi session",
    handler: async (_args, commandContext) => openPanel(commandContext),
  });

  pi.on("session_start", (event, context) => {
    ctx = context;
    syncSession();
    self.state = "idle";
    publish();

    if (context.mode !== "tui") return;
    const GestureEditor = createGestureEditor({
      onGesture: () => void openPanel(context),
      isBlocked: () => panelOpen,
    });
    context.ui.setEditorComponent((tui, theme, keybindings) => new GestureEditor(tui, theme, keybindings) as any);
  });

  pi.on("agent_start", () => {
    self.state = "working";
    self.workingSince = Date.now();
    syncSession();
    publish();
  });

  pi.on("agent_settled", () => {
    self.state = "idle";
    self.workingSince = undefined;
    publish();
  });

  pi.on("session_shutdown", () => {
    removeRecord(registry, self.pid);
  });
}
