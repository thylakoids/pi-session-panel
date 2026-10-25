import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { focusTmuxPane } from "../extension/tmux-focus.ts";

test("focus reports tmux failures instead of pretending the client switched", () => {
  assert.throws(() => focusTmuxPane("%42", args => {
    if (args[0] === "switch-client") throw new Error("client unavailable");
    return "";
  }), /client unavailable/);
});

test("a client in restored sessions can focus Working and Idle panes in other sessions", {
  skip: spawnSync("tmux", ["-V"]).status !== 0,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-panel-focus-"));
  const socket = join(dir, "tmux.sock");
  const run = (args: string[]) => execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  t.after(() => { try { run(["kill-server"]); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const create = (name: string) => run(["new-session", "-d", "-s", name, "-P", "-F", "#{pane_id}", "sleep 120"]);
  const restored = create("pi-sessions");
  const working = create("working");
  const idle = create("idle");
  const client = spawn("tmux", ["-S", socket, "-C", "attach-session", "-t", "pi-sessions"], { stdio: ["pipe", "pipe", "pipe"] });
  client.stdout.resume(); client.stderr.resume();
  t.after(() => { client.stdin.end(); client.kill(); });
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      assert.ok(Date.now() < deadline, "tmux client must reach the target session");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const current = () => run(["list-clients", "-F", "#{session_name}"]);
  await until(() => current() === "pi-sessions");
  // The old implementation changed server selections but left the client here.
  run(["select-window", "-t", working]); run(["select-pane", "-t", working]);
  assert.equal(current(), "pi-sessions");
  for (const [pane, session] of [[working, "working"], [idle, "idle"], [restored, "pi-sessions"]]) {
    focusTmuxPane(pane, run);
    await until(() => current() === session);
    assert.equal(run(["display-message", "-p", "-t", session, "#{pane_id}"]), pane);
  }
  focusTmuxPane(restored, run);
  assert.equal(current(), "pi-sessions", "same-session focus remains valid");
});
