/**
 * Plugin configuration.
 *
 * pi's `settings.json` has a closed schema, so this package keeps its own file:
 * `<agentDir>/session-panel/config.json`. Nothing here has a built-in default,
 * because which model is cheap and available is the user's decision.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PanelConfig {
  /** Model used to name sessions, as `provider/model`. Unset means naming is off. */
  titleModel?: string;
}

export function configPath(agentDir: string): string {
  return join(agentDir, "session-panel", "config.json");
}

/**
 * Read the config.
 *
 * JSON only, and `titleModel` must be a full `provider/model` string. Anything else
 * counts as unset: this file is small enough that there is no reason to guess what
 * a malformed one meant.
 */
export function readConfig(agentDir: string): PanelConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath(agentDir), "utf8");
  } catch {
    return {};
  }
  if (!raw.trim()) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const model = (parsed as { titleModel?: unknown }).titleModel;
    return typeof model === "string" && model.trim() ? { titleModel: model.trim() } : {};
  } catch {
    return {};
  }
}

/**
 * Create the file on first run.
 *
 * Empty means naming is off, which is the only safe default: this package cannot
 * know which model is cheap on someone else's machine.
 */
export function writeConfigExample(agentDir: string): void {
  const path = configPath(agentDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}\n", { flag: "wx" });
  } catch {
    // Already exists, or the directory is read-only.
  }
}
