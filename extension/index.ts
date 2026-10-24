/**
 * pi-session-panel
 *
 * Registers a /sessions command, installs the left-arrow gesture, and keeps this
 * process's own record in the registry while it runs.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { createGestureEditor } from "./editor.ts";
import { SessionsPanel } from "./panel.ts";
import { loadClosed, insertClosed, rowFromInfo, type ClosedIndex } from "./closed.ts";
import { configPath, readConfig, writeConfigExample } from "./config.ts";
import { createNamer } from "./naming.ts";
import { ownPane, rowFromRecord } from "./live.ts";
import { readRegistry, registryDir, removeRecord, writeRecord, type RegistryRecord } from "./registry.ts";
import type { SessionRow } from "./types.ts";

/** Run one tmux command, surfacing its stderr as the error message. */
function runTmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `tmux ${args[0]} failed`);
  }
}

/** Whether a tmux session exists. tmux answers this with its exit code. */
function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The tmux session this pi runs in, as a target tmux will accept. */
function tmuxTarget(): string {
  const pane = process.env.TMUX_PANE;
  if (pane) {
    try {
      return runTmux(["display-message", "-p", "-t", pane, "#{session_name}"]).trim();
    } catch {
      // Fall through to the default target.
    }
  }
  return "";
}

/** tmux window names cannot carry the characters a session name might. */
function windowName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._\-/]/gu, "").trim().slice(0, 40) || "session";
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

  // ── automatic naming ────────────────────────────────────────────────────────
  // Configured, not defaulted: which model is cheap is the user's call.
  writeConfigExample(agentDir);
  const config = readConfig(agentDir);
  const maybeName = createNamer({
    pi,
    model: () => config.titleModel,
    onNamed: (name) => {
      self.name = name;
      publish();
    },
    onBroken: (reason) => {
      // Tell the user once, in the transcript, instead of failing invisibly.
      if (!ctx?.hasUI) return;
      ctx.ui.notify(`Session naming is off: ${reason}. Fix titleModel in ${configPath(agentDir)}.`, "warning");
    },
  });

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
              reopen: (row) => restore(row),
              interrupt: (row) => interrupt(row),
              exit: (row) => exit(row, context),
              remove: (row) => removeSession(row),
              rename: (row, next) => rename(row, next),
              rescan: () => rescan(context),
            },
          });

          // Poll faster than the spinner steps, but only redraw when the frame
          // key actually differs: a no-op tick costs one key comparison.
          let columns = 80;
          const height = () => Math.max(8, Math.min(40, Math.floor((tui.terminal?.rows ?? 40) * 0.85)));
          const timer = setInterval(() => {
            if (panel.needsRedraw(theme, columns, height())) tui.requestRender();
          }, 50);

          return {
            invalidate() {},
            render: (nextColumns: number) => {
              columns = nextColumns;
              return panel.render(theme, columns, height());
            },
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

/** The fixed tmux session that holds reopened sessions. */
const RESTORE_SESSION = "pi-sessions";

/**
 * Reopen a closed session in its own window inside a dedicated tmux session.
 *
 * Reopened sessions get their own tmux session (`pi-sessions`) rather than a window
 * next to your work: they are historical context you visit deliberately, and
 * mixing them into the session you are working in buries the windows that matter.
 *
 * This deliberately does not use `ctx.switchSession()`. That method only exists on
 * the command context, so the panel would behave differently depending on how it
 * was opened, and it would replace the session you are working in.
 */
  const restore = (row: SessionRow) => {
    if (!row.sessionFile) throw new Error("This session has no file to reopen.");
    if (!process.env.TMUX) throw new Error("Reopening needs tmux.");

    const name = windowName(row.name);
    const command = [process.execPath, process.argv[1]!, "--session", row.sessionFile];
    // The restore session is created once and reused: the second reopen adds a
    // window to it instead of failing because the session already exists.
    const exists = tmuxSessionExists(RESTORE_SESSION);
    const pane = runTmux(
      exists
        ? ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${RESTORE_SESSION}:`, "-n", name, "-c", row.cwd, ...command]
        : ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", RESTORE_SESSION, "-n", name, "-c", row.cwd, ...command],
    ).trim();

    if (pane === "") throw new Error("tmux did not create a window.");
    runTmux(["select-window", "-t", pane]);
    runTmux(["select-pane", "-t", pane]);
    // Bring the user there, if a client is attached.
    try {
      runTmux(["switch-client", "-t", RESTORE_SESSION]);
    } catch {
      // Detached: the session exists, it just cannot be shown right now.
    }
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
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      throw new Error(`Could not stop pid ${pid}: ${(error as Error).message}`);
    }
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
    if (row.state !== "closed") throw new Error("Only a closed session can be deleted.");
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
    // A live session's name lives in its own process; tell it, so the next frame
    // shows the new name instead of the one it registered at startup.
    const pid = Number(row.key.replace("live:", ""));
    if (Number.isInteger(pid) && pid !== self.pid) {
      const live = readRegistry(registry).live.find((r) => r.pid === pid);
      if (live) {
        try {
          writeRecord(registry, { ...live, name: next, updatedAt: Date.now() });
        } catch {
          // Best effort: the file already carries the new name.
        }
      }
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
    // A resumed session may already have messages and no name; name it now.
    // Never awaited: naming must not delay startup.
    void maybeName(context);

    if (context.mode !== "tui") return;
    const GestureEditor = createGestureEditor({
      onGesture: () => void openPanel(context),
      isBlocked: () => panelOpen,
    });
    context.ui.setEditorComponent((tui, theme, keybindings) => new GestureEditor(tui, theme, keybindings) as any);
  });

  pi.on("before_agent_start", (event, context) => {
    // The prompt that triggered this run is not on the branch yet, so pass it in.
    if (event.messageType !== "user") return;
    void maybeName(context, event.prompt);
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
