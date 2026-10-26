/** Instance-authenticated, target-owned shutdown on macOS and Linux. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExitControl {
  endpoint: string;
  token: string;
}
export interface ExitTarget {
  pid: number;
  sessionFile?: string;
  idle: boolean;
}
export interface ExitController {
  registration: ExitControl;
  close(): void;
}
const DEADLINE_MS = 2000;
const MAX_MESSAGE = 4096;

/** Private socket directory and a fresh token for each loaded extension instance. */
export async function createExitControl(options: {
  target(): ExitTarget;
  shutdown(): void;
}): Promise<ExitController> {
  const directory = mkdtempSync(join(tmpdir(), "pi-exit-"));
  const registration = { endpoint: join(directory, "control.sock"), token: randomUUID() };
  const sockets = new Set<Socket>();
  let closed = false;
  let stopping = false;
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    sockets.add(socket);
    socket.unref();
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(DEADLINE_MS, () => socket.destroy());
    let text = "", handled = false;
    socket.on("data", chunk => {
      if (handled) return;
      text += chunk.toString("utf8");
      if (text.length > MAX_MESSAGE) { handled = true; socket.destroy(); return; }
      if (!text.includes("\n")) return;
      handled = true;
      try {
        const request = JSON.parse(text.slice(0, text.indexOf("\n")));
        if (closed || stopping || request?.action !== "exit" || request.token !== registration.token) {
          throw new Error("This Pi instance changed or is unavailable. Reload the target and refresh the panel.");
        }
        const current = options.target();
        if (request.pid !== current.pid || request.sessionFile !== current.sessionFile || !current.idle) {
          throw new Error("The target is no longer idle or its session changed. Refresh the panel.");
        }
        // No await between the target's own state check and its shutdown call.
        // Keep the acknowledgement writable during shutdown/reload cleanup.
        stopping = true;
        socket.end('{"ok":true}\n');
        options.shutdown();
      } catch (error) {
        if (!socket.writableEnded) socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
      }
    });
  });
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    for (const socket of sockets) if (!socket.writableEnded) socket.destroy();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(registration.endpoint, () => { server.off("error", reject); resolve(); });
    });
    server.on("error", () => {});
    server.unref();
    return { registration, close };
  } catch (error) {
    close();
    throw error;
  }
}

/** A failed channel never falls back to sending a signal to its PID. */
export function requestExit(control: ExitControl, target: Pick<ExitTarget, "pid" | "sessionFile">): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(control.endpoint);
    socket.setEncoding("utf8");
    let text = "", finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("The target Pi did not answer. Reload the target and refresh the panel.")), DEADLINE_MS);
    socket.on("error", () => finish(new Error("Cannot contact this Pi instance. Reload the target and refresh the panel.")));
    socket.on("end", () => { if (!finished) finish(new Error("The target Pi closed without confirming exit. Refresh the panel.")); });
    socket.on("connect", () => socket.write(JSON.stringify({ action: "exit", token: control.token, ...target }) + "\n"));
    socket.on("data", chunk => {
      text += chunk.toString("utf8");
      if (text.length > MAX_MESSAGE) { finish(new Error("Invalid response from the target Pi.")); return; }
      if (!text.includes("\n")) return;
      try {
        const reply = JSON.parse(text.slice(0, text.indexOf("\n")));
        finish(reply?.ok === true ? undefined : new Error(typeof reply?.error === "string" ? reply.error : "The target Pi refused to exit."));
      } catch { finish(new Error("Invalid response from the target Pi.")); }
    });
  });
}
