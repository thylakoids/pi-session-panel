import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { createGestureEditor } from "./editor.ts";
import { SessionsPanel } from "./panel.ts";
import { discardEmptySession, closedScanDir, insertClosed, scanClosed, type ClosedIndex } from "./closed.ts";
import { readClosedCache, writeClosedCache, type CachedClosedRow } from "./closed-cache.ts";
import { configPath, readConfig, writeConfigExample } from "./config.ts";
import { createNamer, generateSessionTitle } from "./naming.ts";
import { createRowsSource } from "./live.ts";
import { readRecord, readRegistry, registryDir, removeRecord, writeRecord, type RegistryRecord } from "./registry.ts";
import type { SessionRow } from "./types.ts";
import { focusTmuxPane } from "./tmux-focus.ts";
import { readProcessIdentity } from "./process-identity.ts";
import { stopRegisteredSession } from "./exit.ts";
import { createExitControl, type ExitController } from "./exit-control.ts";

/** Run one tmux command, surfacing its stderr as the error message. */
function runTmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `tmux ${args[0]} failed`);
  }
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const registry = registryDir(agentDir);

  /** This process's own state, mirrored into the registry on every change. */
  const self: RegistryRecord = {
    pid: process.pid,
    processIdentity: readProcessIdentity(process.pid),
    cwd: process.cwd(), state: "idle", updatedAt: Date.now(), pane: process.env.TMUX_PANE,
  };

  let ctx: ExtensionContext | undefined;

  // ── automatic naming ────────────────────────────────────────────────────────
  writeConfigExample(agentDir);
  const maybeName = createNamer({
    pi,
    model: () => readConfig(agentDir).titleModel,
    syncName: () => syncSession(),
    onNamed: (name) => {
      self.name = name;
      publish();
    },
    onBroken: (reason) => {
      if (!ctx?.hasUI) return;
      ctx.ui.notify(`Session naming is off: ${reason}. Fix titleModel in ${configPath(agentDir)}.`, "warning");
    },
  });

  const publish = () => {
    self.updatedAt = Date.now();
    try {
      writeRecord(registry, self);
    } catch {
      // A read-only or missing agent dir must not break the session.
    }
  };

  let exitController: ExitController | undefined;
  let exitGeneration = 0;
  const closeExitControl = () => {
    exitGeneration++;
    self.exitControl = undefined;
    exitController?.close();
    exitController = undefined;
  };
  const openExitControl = () => {
    closeExitControl();
    const generation = exitGeneration;
    void createExitControl({
      target: () => ({ pid: self.pid, sessionFile: ctx?.sessionManager.getSessionFile(),
        idle: Boolean(ctx && self.state === "idle" && ctx.isIdle()) }),
      shutdown: () => ctx?.shutdown(),
    }).then(controller => {
      if (generation !== exitGeneration) { controller.close(); return; }
      exitController = controller;
      self.exitControl = controller.registration;
      publish();
    }).catch(() => {
      // Socket setup must not prevent Pi from starting. Without a channel,
      // only the existing verifiable Linux registration can authorize exit.
    });
  };

  /** Keep the record's session file and name in step with the real session. */
  const syncSession = (force = false) => {
    const file = ctx?.sessionManager.getSessionFile();
    const record = readRecord(registry, self.pid);
    if (file && record?.sessionFile === file && record.name && record.name !== self.name) pi.setSessionName(record.name);
    const name = ctx?.sessionManager.getSessionName();
    if (force || file !== self.sessionFile || name !== self.name) {
      Object.assign(self, { sessionFile: file, name });
      publish();
    }
  };

  const setState = (state: RegistryRecord["state"]) => {
    self.state = state;
    self.workingSince = state === "working" ? Date.now() : undefined;
    syncSession(true);
  };

  // ── closed index ────────────────────────────────────────────────────────────
  let closedIndex: ClosedIndex | null = null;
  let closedCache: CachedClosedRow[] = [];
  /** The scan in flight, so a second request joins it instead of being dropped. */
  let scanInFlight: Promise<void> | null = null;
  const closedEdits = new Map<string, SessionRow | null>();
  let scanController = new AbortController();
  /** Whether the current closedIndex came from a real scan, not the cache. */
  let fresh = false;

  /** Custom --session-dir indexes must never seed each other. */
  const cachePath = (context: ExtensionContext) => {
    const directory = closedScanDir(context.sessionManager);
    const suffix = directory ? "-" + createHash("sha256").update(directory).digest("hex").slice(0, 16) : "";
    return join(agentDir, "session-panel", "closed-cache" + suffix + ".json");
  };

  const editClosed = (key: string, row: SessionRow | null) => {
    if (!closedIndex) return;
    closedIndex = row ? insertClosed(closedIndex, row) : { ...closedIndex, rows: closedIndex.rows.filter(r => r.key !== key) };
    closedCache = row ? closedCache.map(entry => entry.row.key === key ? { ...entry, row: { ...entry.row, ...row } } : entry)
      : closedCache.filter(entry => entry.row.key !== key);
    if (scanInFlight) closedEdits.set(key, row);
  };

  const runScan = (context: ExtensionContext): Promise<void> => {
    // Refresh callers join the same scan.
    if (scanInFlight) return scanInFlight;
    scanInFlight = (async () => {
      const dir = closedScanDir(context.sessionManager);
      const signal = scanController.signal;
      const result = await scanClosed(dir, closedCache, signal);
      signal.throwIfAborted();
      closedIndex = { rows: result.rows, loadedAt: Date.now() };
      closedCache = result.cache;
      for (const [key, row] of closedEdits) editClosed(key, row);
      fresh = true;
      writeClosedCache(cachePath(context), closedCache);
      rowsSource.refresh();
    })().finally(() => {
      scanInFlight = null;
      closedEdits.clear();
    });
    return scanInFlight;
  };

  // ── rows ────────────────────────────────────────────────────────────────────
  const rowsSource = createRowsSource(() => readRegistry(registry).live, () => closedIndex?.rows, self);

  // ── panel ───────────────────────────────────────────────────────────────────
  let panelOpen = false;

  async function openPanel(context: ExtensionContext): Promise<void> {
    if (panelOpen) return;
    if (context.mode !== "tui") {
      context.ui.notify("The sessions panel needs interactive mode.", "warning");
      return;
    }
    if (!closedIndex) {
      closedCache = readClosedCache(cachePath(context))?.rows ?? [];
      closedIndex = { rows: closedCache.map(entry => entry.row), loadedAt: Date.now() };
    }
    if (!fresh) void runScan(context).catch(() => { /* Keep cached rows; retry on next open. */ });
    rowsSource.refresh();
    panelOpen = true;

    try {
      await context.ui.custom(
        (tui: any, theme: any, _bindings: any, done: (value?: unknown) => void) => {
          let closed = false;
          let timer: ReturnType<typeof setInterval>;
          const close = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            panel.dispose();
            done(undefined);
          };

          const panel = new SessionsPanel({
            rows: () => rowsSource.rows,
            rowsVersion: () => rowsSource.version,
            close,
            actions: {
              focus: focusPane,
              reopen: restore,
              interrupt,
              exit,
              remove: removeSession,
              rename,
              generateName: (row, signal) => generateSessionTitle(context, row.sessionFile, readConfig(agentDir).titleModel, signal),
              rescan: () => runScan(context),
            },
          });

          // Poll data at 50ms without rebuilding unchanged projections.
          let columns = 80;
          const height = () => Math.max(8, Math.min(40, Math.floor((tui.terminal?.rows ?? 40) * 0.85)));
          timer = setInterval(() => {
            rowsSource.refresh();
            if (!closed && panel.needsRedraw(theme, columns, height())) tui.requestRender();
          }, 50);

          return {
            invalidate: () => panel.invalidate(),
            render: (nextColumns: number) => {
              columns = nextColumns;
              return panel.render(theme, columns, height());
            },
            handleInput: (data: string) => {
              const pending = panel.handleInput(data);
              tui.requestRender();
              void pending.finally(() => { if (!closed) tui.requestRender(); });
            },
            dispose: () => {
              closed = true;
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
  const focusPane = (row: SessionRow) => {
    if (!row.pane) throw new Error("This session is not in tmux.");
    focusTmuxPane(row.pane, runTmux);
  };

  const RESTORE_SESSION = "pi-sessions";

  // Restores get a separate tmux session; never replace the current Pi session.
  const restore = (row: SessionRow) => {
    if (!row.sessionFile) throw new Error("This session has no file to reopen.");
    if (!process.env.TMUX) throw new Error("Reopening needs tmux.");

    const name = row.name.replace(/[^\p{L}\p{N} ._\-/]/gu, "").trim().slice(0, 40) || "session";
    const command = [process.execPath, process.argv[1]!, "--session", row.sessionFile];

    let exists = false;
    try { runTmux(["has-session", "-t", "=" + RESTORE_SESSION]); exists = true; } catch { /* Create it below. */ }
    const pane = runTmux(
      exists
        ? ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${RESTORE_SESSION}:`, "-n", name, "-c", row.cwd, ...command]
        : ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", RESTORE_SESSION, "-n", name, "-c", row.cwd, ...command],
    ).trim();

    if (pane === "") throw new Error("tmux did not create a window.");
    runTmux(["select-window", "-t", pane]);
    runTmux(["select-pane", "-t", pane]);

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

  const exit = async (row: SessionRow) => {
    await stopRegisteredSession(registry, row);
    if (discardEmptySession(row.sessionFile)) {
      editClosed(`closed:${row.sessionFile ?? row.key}`, null);
      rowsSource.refresh();
      return;
    }
    // Refresh an existing history entry too; live files are already in the index.
    if (closedIndex) {
      const closed: SessionRow = {
        ...row, current: false,
        state: "closed",
        key: `closed:${row.sessionFile ?? row.key}`,
        updatedAt: Date.now(),
        workingSince: undefined,
        pane: undefined,
        processIdentity: undefined,
        exitControl: undefined,
      };
      editClosed(closed.key, closed);
    }
    rowsSource.refresh();
  };

  const removeSession = async (row: SessionRow) => {
    if (!row.sessionFile) throw new Error("This session has no file to delete.");
    if (row.state !== "closed") throw new Error("Only a closed session can be deleted.");
    await rm(row.sessionFile, { force: true });
    editClosed(row.key, null);
    rowsSource.refresh();
  };

  const rename = async (row: SessionRow, next: string) => {
    if (!row.sessionFile) throw new Error("This session has no file to name.");
    if (row.sessionFile === self.sessionFile) pi.setSessionName(next);
    else SessionManager.open(row.sessionFile).appendSessionInfo(next);
    const key = "closed:" + row.sessionFile;
    const history = closedIndex?.rows.find(r => r.key === key);
    if (history) {
      const prefix = (history.sessionId ?? "") + " " + history.name + " ";
      const text = history.searchText;
      const unnamed = (history.sessionId ?? "") + "  ";
      const body = text?.startsWith(prefix) ? text.slice(prefix.length) : text?.startsWith(unnamed) ? text.slice(unnamed.length) : text;
      const searchText = text && (history.sessionId ?? "") + " " + next + " " + body;
      editClosed(key, { ...history, name: next, searchText });
    }
    // Let the target adopt the saved name on its next lifecycle event.
    const pid = Number(row.key.replace("live:", ""));
    if (pid === self.pid) {
      self.name = next;
      publish();
    } else if (Number.isInteger(pid)) {
      const live = readRecord(registry, pid);
      if (live?.sessionFile === row.sessionFile) {
        try {
          writeRecord(registry, { ...live, name: next, updatedAt: Date.now() });
        } catch {
          // Best effort: the file already carries the new name.
        }
      }
    }
    rowsSource.refresh();
  };

  // ── wiring ──────────────────────────────────────────────────────────────────
  pi.registerCommand("sessions", {
    description: "Manage every running and closed pi session",
    handler: async (_args, commandContext) => openPanel(commandContext),
  });

  pi.on("session_start", (event, context) => {
    maybeName.cancel();
    scanController = new AbortController();
    ctx = context;
    setState("idle");
    openExitControl();
    // Naming must not delay startup.
    void maybeName(context);

    if (context.mode !== "tui") return;
    const GestureEditor = createGestureEditor({
      onGesture: () => void openPanel(context),
      isBlocked: () => panelOpen,
    });
    context.ui.setEditorComponent((tui, theme, keybindings) => new GestureEditor(tui, theme, keybindings) as any);
  });

  // Cancel before navigation can replace the naming context.
  pi.on("session_before_switch", () => { maybeName.cancel(); });
  pi.on("session_before_fork", () => { maybeName.cancel(); });
  pi.on("session_before_tree", () => { maybeName.cancel(); });
  pi.on("session_tree", (_event, context) => {
    maybeName.cancel();
    void maybeName(context);
  });

  pi.on("before_agent_start", (event, context) => {
    // The prompt that triggered this run is not on the branch yet, so pass it in.
    if (event.messageType !== "user") return;
    syncSession();
    void maybeName(context, event.prompt);
  });

  pi.on("agent_start", () => setState("working"));
  pi.on("agent_settled", () => setState("idle"));

  pi.on("session_shutdown", () => {
    closeExitControl();
    scanController.abort();
    maybeName.cancel();
    removeRecord(registry, self.pid);
  });
}
