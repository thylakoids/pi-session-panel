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

export function configPath(agentDir: string): string {
  return join(agentDir, "session-panel", "config.json");
}

/** Read the config, returning an empty one when the file is missing or broken. */
export function readConfig(agentDir: string): PanelConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(agentDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const model = (parsed as { titleModel?: unknown }).titleModel;
    return typeof model === "string" && model.trim() ? { titleModel: model.trim() } : {};
  } catch {
    return {};
  }
}

/** Write a commented example so the file is discoverable without docs. */
export function writeConfigExample(agentDir: string): void {
  const path = configPath(agentDir);
  try {
    writeFileSync(
      path,
      JSON.stringify({ titleModel: "" }, null, 2) + "\n",
      { flag: "wx" },
    );
  } catch {
    // Already exists, or the directory is read-only.
  }
}
