import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";

test("real naming model produces a rename draft before Enter saves it in official Pi", {
  skip: process.env.PI_PANEL_NAMING_LIVE !== "1", timeout: 120_000,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), "panel-rename-live-"));
  const path = (process.env.PATH ?? "").split(delimiter).filter(entry => !entry.endsWith("/node_modules/.bin")).join(delimiter);
  console.log("Rename model evidence: " + dir);
  const child = spawn(process.env.PI_TEST_PI || "pi", ["--mode", "rpc", "-ne", "-ns", "-np", "-nc", "--no-mcp", "--approve",
    "-e", resolve(import.meta.dirname, "fixtures/rename-live.ts"), "--session-dir", dir, "--session", join(dir, "parent.jsonl")], {
    cwd: dir, env: { ...process.env, PATH: path, PI_RENAME_LIVE_DIR: dir }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { child.stdin.end(); if (child.exitCode === null) child.kill(); });
  let output = "";
  child.stdout.on("data", data => output += data);
  child.stderr.on("data", data => output += data);
  let launchError: Error | undefined;
  child.once("error", error => { launchError = error; });
  const deadline = Date.now() + 90_000;
  while (!existsSync(join(dir, "result.json"))) {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, output);
    assert.ok(Date.now() < deadline, "live rename must publish its result; evidence: " + dir);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  // RPC mode reads until EOF even after the extension requests shutdown.
  const exited = child.exitCode !== null ? Promise.resolve(child.exitCode)
    : new Promise<number | null>(resolve => child.once("exit", resolve));
  child.stdin.end();
  const code = await exited;
  writeFileSync(join(dir, "parent.log"), output);
  assert.equal(code, 0, output);
  const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.calls, 1);
  assert.deepEqual(result.checks, ["selected-branch-tail", "same-model-api", "draft-only", "enter-saves"]);
});
