import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discardEmptySession, scanClosed } from "../extension/closed.ts";

test("empty cleanup preserves messages, summaries, unknown entries and damaged JSON", async t => {
  const dir = mkdtempSync(join(tmpdir(), "panel-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const header = JSON.stringify({ type: "session", version: 3, id: "test", cwd: dir, timestamp: new Date().toISOString() });
  const file = join(dir, "session.jsonl");
  for (const entry of [
    { type: "message", message: { role: "user", content: [{ type: "image", data: "image" }] } },
    { type: "message", message: { role: "assistant", content: "kept" } },
    { type: "compaction", summary: "kept" },
    { type: "branch_summary", summary: "kept" },
    { type: "custom_message", content: "kept" },
    { type: "future_entry", data: "kept" },
  ]) {
    writeFileSync(file, header + "\n" + JSON.stringify(entry) + "\n");
    assert.equal(discardEmptySession(file), false, entry.type);
    assert.equal(existsSync(file), true);
  }
  writeFileSync(file, header + '\n{"type":"message"');
  assert.equal(discardEmptySession(file), false);
  writeFileSync(file, header + '\n{"type":"model_change","modelId":"test"}\n');
  const result = await scanClosed(dir);
  assert.equal(result.rows.length, 0);
  assert.equal(existsSync(file), true, "scanning hides empty history without deleting files");
  assert.equal(discardEmptySession(file), true);
  assert.equal(existsSync(file), false);
});
