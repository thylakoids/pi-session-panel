/** Guard/cleanup for disposable real-Pi E2E only; no mocked panel or shutdown. */
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export default function (pi: any) {
  const dir = process.env.PI_PANEL_EXIT_LIVE_DIR;
  const role = process.env.PI_PANEL_EXIT_LIVE_ROLE;
  if (!dir?.startsWith("/tmp/pi-panel-exit-live-") || !role || !["target", "host", "busy"].includes(role)) throw new Error("Exit E2E requires its isolated fixture environment");
  const log = (event: string, details: object = {}) => appendFileSync(join(dir, role + ".events.jsonl"), JSON.stringify({ event, pid: process.pid, ...details }) + "\n");
  let timer: ReturnType<typeof setInterval> | undefined;
  let release: (() => void) | undefined;
  pi.on("session_start", (event: any, ctx: any) => {
    log("session_start", { reason: event.reason, mode: ctx.mode, file: ctx.sessionManager.getSessionFile() });
    ctx.modelRegistry.complete = () => { log("forbidden_model_call"); throw new Error("E2E forbids model calls"); };
    clearInterval(timer);
    timer = setInterval(() => {
      const quit = join(dir, role + ".quit");
      if (!existsSync(quit)) return;
      if (!ctx.isIdle()) {
        // Abort before releasing preflight; Pi aborts agent_start before its
        // first provider call. Keep the quit flag until the run is idle.
        ctx.abort();
        release?.(); release = undefined;
        return;
      }
      unlinkSync(quit);
      log("fixture_cleanup", { idle: true });
      ctx.shutdown();
    }, 25);
  });
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    log("held_before_model", { idle: ctx.isIdle() });
    // Exercise Pi's actual busy state without allowing its first provider call.
    await new Promise<void>(resolve => { release = resolve; });
  });
  pi.on("agent_start", (_event: any, ctx: any) => {
    if (ctx.signal?.aborted) log("aborted_before_provider");
    else { log("forbidden_agent_start"); process.exit(93); }
  });
  pi.on("session_shutdown", (event: any) => { clearInterval(timer); log("session_shutdown", { reason: event.reason }); });
}
