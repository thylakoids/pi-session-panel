/** Production rename UI and provider call in an isolated official Pi session. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { readConfig } from "../../extension/config.ts";
import { generateSessionTitle, capInput, RENAME_CONTENT_LIMIT } from "../../extension/naming.ts";
import { SessionsPanel } from "../../extension/panel.ts";

export default function (pi: any) {
  pi.on("session_start", async (_event: any, context: any) => {
    const dir = process.env.PI_RENAME_LIVE_DIR!;
    const file = join(dir, "selected.jsonl");
    const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text };
    let panel: SessionsPanel | undefined;
    try {
      const model = process.env.PI_TEST_TITLE_MODEL || readConfig(getAgentDir()).titleModel;
      assert.ok(model, "Configure titleModel or set PI_TEST_TITLE_MODEL for the live test");
      const prompts = ["Earlier unrelated setup. ".repeat(800), "The session panel needs LLM rename from all user prompts. Preserve the latest topic. ".repeat(80), "Pi session panel manual LLM rename"];
      const rows = prompts.map((text, index) => ({ type: "message", id: `u${index}`, parentId: index ? `u${index - 1}` : null, message: { role: "user", content: text } }));
      writeFileSync(file, [
        { type: "session", version: 3, id: "rename-live", timestamp: new Date().toISOString(), cwd: dir }, ...rows,
        { type: "session_info", id: "name", parentId: rows.at(-1)!.id, name: "Old label" },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      const original = readFileSync(file, "utf8");
      const complete = context.modelRegistry.complete.bind(context.modelRegistry);
      let calls = 0;
      context.modelRegistry.complete = async (selected: any, request: any, options: any) => {
        calls++;
        assert.equal(`${selected.provider}/${selected.id}`, model);
        const source = request.messages[0].content.split("<session>\n")[1].split("\n</session>")[0];
        assert.equal(source, capInput(prompts.join("\n"), RENAME_CONTENT_LIMIT).trim());
        return complete(selected, request, options);
      };
      let generated = "";
      const selected = { key: "selected", state: "closed" as const, name: "Old label", cwd: dir, sessionFile: file, updatedAt: Date.now() };
      panel = new SessionsPanel({ rows: () => [selected], close() {}, actions: {
        generateName: async (row, signal) => generated = await generateSessionTitle(context, row.sessionFile, model, AbortSignal.any([signal, AbortSignal.timeout(60_000)])),
        rename: (row, title) => { SessionManager.open(row.sessionFile!).appendSessionInfo(title); },
        focus() {}, reopen() {}, interrupt() {}, exit() {}, remove() {}, rescan() {},
      } });
      panel.render(theme, 90, 12);
      await panel.handleInput("r"); await panel.handleInput("\x07");
      const deadline = Date.now() + 65_000;
      while (!generated) {
        if (panel.errorText()) throw new Error(panel.errorText()!);
        assert.ok(Date.now() < deadline, "live title generation must complete");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(calls, 1);
      assert.equal(readFileSync(file, "utf8"), original, "the model must only create a draft");
      assert.match(generated, /panel|session|naming|rename|会话|命名/i);
      assert.ok(panel.render(theme, 90, 12).join("\n").includes(generated));
      await panel.handleInput("\r");
      assert.equal(SessionManager.open(file).getSessionName(), generated);
      writeFileSync(join(dir, "result.json"), JSON.stringify({ ok: true, model, title: generated, calls, checks: ["selected-branch-tail", "same-model-api", "draft-only", "enter-saves"] }));
    } catch (error) {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ ok: false, error: String(error) }));
    } finally {
      panel?.dispose();
      context.shutdown();
    }
  });
}
