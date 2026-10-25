/**
 * pi-session-panel
 *
 * Registers a /sessions command, installs the left-arrow gesture, and keeps this
 * process's own record in the registry while it runs.
 */
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { createGestureEditor } from "./editor.ts";
import { SessionsPanel } from "./panel.ts";
import { closedScanDir, insertClosed, scanClosed, type ClosedIndex } from "./closed.ts";
import { readClosedCache, writeClosedCache, type CachedClosedRow } from "./closed-cache.ts";
import { configPath, readConfig, writeConfigExample } from "./config.ts";
import { createNamer, generateSessionTitle } from "./naming.ts";
import { dedupeLive, ownPane, rowFromRecord, withoutLiveDuplicates } from "./live.ts";
import { readRegistry, registryDir, removeRecord, writeRecord, type RegistryRecord } from "./registry.ts";
import type { SessionRow } from "./types.ts";
import { focusTmuxPane } from "./tmux-focus.ts";

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
    // Another panel updates our registry record after renaming the file.
    // Adopt it before publishing the in-memory name over that change.
    const externalName = file ? readRegistry(registry).live.find(record => record.pid === self.pid && record.sessionFile === file)?.name : undefined;
    if (externalName && externalName !== self.name) pi.setSessionName(externalName);
    const name = ctx?.sessionManager.getSessionName();
    if (name !== self.name) {
      self.name = name;
      changed = true;
    }
    if (changed) publish();
  };

  // ── closed index ────────────────────────────────────────────────────────────
  /**
   * The closed rows. A scan of every session file costs ~1.6s here, so the list
   * comes from the cache file first and the scan only refreshes what changed.
   * See docs/adr/0011.
   */
  let closedIndex: ClosedIndex | null = null;
  let closedCache: CachedClosedRow[] = [];
  /** The scan in flight, so a second request joins it instead of being dropped. */
  let scanInFlight: Promise<void> | null = null;
  /** Whether the current closedIndex came from a real scan, not the cache. */
  let fresh = false;

  /** The cache file, once per process: the path never changes. */
  const cachePath = join(agentDir, "session-panel", "closed-cache.json");

  /** Guess at what the scan would produce, straight from the last run. */
  const seedFromCache = (): SessionRow[] => {
    const cache = readClosedCache(cachePath);
    if (!cache) return [];
    closedCache = cache.rows;
    return cache.rows.map((entry) => entry.row);
  };

  /**
   * Scan, publish, cache.
   *
   * The pass over unchanged directories costs ~13ms because each file only
   * contributes a stamp; only the directories with a new or edited file are
   * handed back to pi to re-read.
   */
  const runScan = (context: ExtensionContext): Promise<void> => {
    // Joining the scan in flight is what makes R work while the first load is
    // still running: dropping the request would leave the user with a refresh
    // key that silently does nothing.
    if (scanInFlight) return scanInFlight;
    scanInFlight = (async () => {
      const dir = closedScanDir(context.sessionManager);
      const result = await scanClosed(dir, closedCache);
      closedIndex = { rows: result.rows, loadedAt: Date.now() };
      closedCache = result.cache;
      fresh = true;
      writeClosedCache(cachePath, result.cache);
    })().finally(() => {
      scanInFlight = null;
    });
    return scanInFlight;
  };

  /**
   * Make the closed section usable as early as possible.
   *
   * The cache is read synchronously so the first frame already has rows, then the
   * incremental scan replaces them. Without the cache the section is empty for as
   * long as the scan takes, which is what made opening a fresh pi feel slow.
   */
  const ensureClosedLoaded = (context: ExtensionContext) => {
    if (!closedIndex) {
      const seeded = seedFromCache();
      if (seeded.length > 0) closedIndex = { rows: seeded, loadedAt: Date.now() };
    }
    if (fresh) return;
    void runScan(context).catch(() => {
      // The cache, if any, stays on screen; the next open retries.
    });
  };

  /** Rescan on demand (the R key). */
  const rescan = async (context: ExtensionContext): Promise<void> => {
    await runScan(context);
  };

  // ── rows ────────────────────────────────────────────────────────────────────
  const rows = (): SessionRow[] => {
    const { live } = readRegistry(registry);
    const liveRows = dedupeLive(live).map(record => rowFromRecord(record, self));
    return [...liveRows, ...withoutLiveDuplicates(closedIndex?.rows ?? [], liveRows)];
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
            actions: {
              focus: (row) => focusPane(row, context),
              reopen: (row) => restore(row),
              interrupt: (row) => interrupt(row),
              exit: (row) => exit(row),
              remove: (row) => removeSession(row),
              rename: (row, next) => rename(row, next),
              generateName: (row, signal) => generateSessionTitle(context, row.sessionFile, readConfig(agentDir).titleModel, signal),
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
    focusTmuxPane(row.pane, runTmux);
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
  const exit = (row: SessionRow) => {
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
    if (row.sessionFile === self.sessionFile) pi.setSessionName(next);
    else SessionManager.open(row.sessionFile).appendSessionInfo(next);
    if (closedIndex) {
      closedIndex = { ...closedIndex, rows: closedIndex.rows.map((r) => (r.key === row.key ? { ...r, name: next } : r)) };
    }
    // A live session's name lives in its own process; tell it, so the next frame
    // shows the new name instead of the one it registered at startup.
    const pid = Number(row.key.replace("live:", ""));
    if (pid === self.pid) {
      // Renaming the session you are sitting in: nothing else will publish this,
      // and skipping it left the row showing the old name forever.
      self.name = next;
      self.updatedAt = Date.now();
      publish();
    } else if (Number.isInteger(pid)) {
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
    syncSession();
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
