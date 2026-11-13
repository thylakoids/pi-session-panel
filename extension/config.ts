/** Plugin settings live outside Pi's closed settings.json schema. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PanelConfig {
  /** Full provider/model identifier; unset disables naming. */
  titleModel?: string;
}

export function configPath(agentDir: string): string {
  return join(agentDir, "session-panel", "config.json");
}

export function readConfig(agentDir: string): PanelConfig {
  try {
    const model = JSON.parse(readFileSync(configPath(agentDir), "utf8"))?.titleModel;
    return typeof model === "string" && model.trim() ? { titleModel: model.trim() } : {};
  } catch { return {}; }
}

export function writeConfigExample(agentDir: string): void {
  const path = configPath(agentDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}\n", { flag: "wx" });
  } catch { /* Already exists or read-only. */ }
}
