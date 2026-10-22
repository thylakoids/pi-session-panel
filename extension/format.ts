const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Duration of a running session, to the second: 7s, 1m07s, 1h02m. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Coarse age for a session that is not running: now, 4m, 3h, 2d. */
export function formatAge(updatedAt: number, at = Date.now()): string {
  const delta = Math.max(0, at - updatedAt);
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  return `${Math.floor(delta / DAY)}d`;
}

/** Shorten a cwd to its last segment, keeping a leading ~ for the home directory. */
export function shortCwd(cwd: string): string {
  const home = process.env.HOME ?? "";
  const display = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const parts = display.split("/").filter(Boolean);
  return parts.length <= 1 ? display : parts.at(-1)!;
}
