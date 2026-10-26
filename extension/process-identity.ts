/** Targeted process-birth lookup; never discovers unregistered sessions. */
import { readFileSync } from "node:fs";

export interface ProcessIdentityIO {
  platform: NodeJS.Platform;
  readText: (path: string) => string;
}

const system: ProcessIdentityIO = {
  platform: process.platform,
  readText: (path) => readFileSync(path, "utf8"),
};

/**
 * Capture once in the registering Pi, then compare immediately before SIGTERM.
 * PID + kernel start ticks + boot ID identifies a process lifetime on Linux.
 * macOS ps lstart has only second precision: do not treat it as proof. Missing
 * procfs, unsupported platforms and unreadable/malformed data all fail closed.
 */
export function readProcessIdentity(pid: number, io: ProcessIdentityIO = system): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || io.platform !== "linux") return undefined;
  try {
    const boot = io.readText("/proc/sys/kernel/random/boot_id").trim();
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(boot)) return undefined;
    const stat = io.readText(`/proc/${pid}/stat`);
    // comm is parenthesized but can itself contain spaces and closing parens.
    if (!stat.startsWith(`${pid} (`)) return undefined;
    const end = stat.lastIndexOf(")");
    if (end < 0 || stat[end + 1] !== " ") return undefined;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    // fields[0] is field 3 (state); fields[19] is field 22 (starttime).
    if (!/^[RSDTtWKPI]$/.test(fields[0] ?? "")) return undefined;
    const start = fields[19];
    if (!start || !/^(0|[1-9]\d*)$/.test(start)) return undefined;
    return `linux:${boot.toLowerCase()}:${start}`;
  } catch {
    return undefined;
  }
}
