/**
 * Plugin configuration.
 *
 * pi's `settings.json` has a closed schema, so this package keeps its own file:
 * `<agentDir>/session-panel/config.json`. Everything is optional; nothing here has
 * a built-in default, because which model is cheap and available is the user's
 * decision, not the package's.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PanelConfig {
  /**
   * Model used to name sessions, as `provider/model`. Unset means naming is off.
   * Example: "magpie/glm-5.3-flash".
   */
  titleModel?: string;
}

/**
 * The provider this pi is configured to use by default.
 *
 * Read straight from settings.json rather than through the extension API, because
 * the API exposes the session's current model, not the configured default.
 */
export function readDefaultProvider(agentDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as unknown;
    const value = (parsed as { defaultProvider?: unknown })?.defaultProvider;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export function configPath(agentDir: string): string {
  return join(agentDir, "session-panel", "config.json");
}

/** Read the config, returning an empty one when the file is missing or broken. */
/**
 * Read the config.
 *
 * A plain string is accepted as shorthand for `{ "titleModel": ... }`, because the
 * only setting is a model id and making people write JSON to set one string is a
 * needless chance to get the syntax wrong.
 *
 *   "glm-5.3-flash"
 *   { "titleModel": "glm-5.3-flash" }
 */
export function readConfig(agentDir: string): PanelConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath(agentDir), "utf8");
  } catch {
    return {};
  }
  const trimmed = raw.trim();
  if (!trimmed) return {};

  // A bare string is the whole config.
  if (!trimmed.startsWith("{")) {
    const bare = trimmed.replace(/^["']|["']$/g, "").trim();
    return bare ? { titleModel: bare } : {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const model = (parsed as { titleModel?: unknown }).titleModel;
    return typeof model === "string" && model.trim() ? { titleModel: model.trim() } : {};
  } catch {
    return {};
  }
}

/**
 * Create the file on first run, empty.
 *
 * Empty means naming is off, which is the only safe default: this package cannot
 * know which model is cheap on someone else's machine.
 */
export function writeConfigExample(agentDir: string): void {
  try {
    writeFileSync(configPath(agentDir), "", { flag: "wx" });
  } catch {
    // Already exists, or the directory is read-only.
  }
}
