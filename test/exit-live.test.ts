/** Opt-in real installed Pi + real tmux TUI + real IPC, with no provider calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { stopRegisteredSession } from "../extension/exit.ts";
import { requestExit } from "../extension/exit-control.ts";
import { rowFromRecord } from "../extension/live.ts";
import type { RegistryRecord } from "../extension/registry.ts";

const pause = () => new Promise(resolve => setTimeout(resolve, 25));
async function until(check: () => boolean, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) { assert.ok(Date.now() < deadline, label); await pause(); }
}

test("real Pi TUI Idle X exits the target; reload and stale/busy checks remain safe", {
  skip: process.env.PI_PANEL_EXIT_LIVE !== "1", timeout: 60_000,
}, async t => {
  const dir = mkdtempSync("/tmp/pi-panel-exit-live-");
  console.log("Real Pi exit evidence: " + dir);
  const agent = join(dir, "agent"), registry = join(agent, "session-panel", "registry");
  mkdirSync(join(agent, "session-panel"), { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ theme: "dark" }));
  writeFileSync(join(agent, "session-panel", "config.json"), "{}\n");
  const path = (process.env.PATH ?? "").split(delimiter).filter(entry => !entry.endsWith("/node_modules/.bin")).join(delimiter);
  const pi = process.env.PI_TEST_PI || execFileSync("which", ["pi"], { env: { ...process.env, PATH: path }, encoding: "utf8" }).trim();
  const socket = join(dir, "tmux.sock");
  const tmux = (args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const fixtures: { role: string; pane: string; file: string }[] = [];
  const events = (role: string) => existsSync(join(dir, role + ".events.jsonl"))
    ? readFileSync(join(dir, role + ".events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const records = (): RegistryRecord[] => {
    if (!existsSync(registry)) return [];
    return readdirSync(registry).flatMap(pid => { try { return [JSON.parse(readFileSync(join(registry, pid, "record.json"), "utf8"))]; } catch { return []; } });
  };
  const record = (file: string) => records().find(row => row.sessionFile === file);
  const capture = (pane: string) => tmux(["capture-pane", "-p", "-t", pane]);
  const command = (pane: string, text: string) => { tmux(["send-keys", "-t", pane, "-l", text]); tmux(["send-keys", "-t", pane, "Enter"]); };
  const alive = (pane: string) => tmux(["display-message", "-p", "-t", pane, "#{pane_dead}"]) === "0";
  const launch = async (role: string) => {
    const file = join(dir, role + ".jsonl");
    writeFileSync(file, [
      { type: "session", version: 3, id: "exit-e2e-" + role, timestamp: new Date().toISOString(), cwd: dir },
      { type: "message", id: "u", parentId: null, message: { role: "user", content: "Isolated exit fixture; never call a model", timestamp: Date.now() } },
      { type: "session_info", id: "n", parentId: "u", name: "E2E " + role },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const pane = tmux(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", role, "-x", "120", "-y", "35", "-c", dir,
      "env", "PATH=" + path, "PI_CODING_AGENT_DIR=" + agent, "PI_OFFLINE=1", "TERM=xterm-256color",
      "PI_PANEL_EXIT_LIVE_DIR=" + dir, "PI_PANEL_EXIT_LIVE_ROLE=" + role,
      pi, "--offline", "-ne", "-ns", "-np", "-nc", "--no-mcp", "--no-tools", "--approve",
      "-e", resolve(import.meta.dirname, "../extension/index.ts"), "-e", resolve(import.meta.dirname, "fixtures/exit-live.ts"), "--session", file]);
    tmux(["set-option", "-g", "remain-on-exit", "on"]);
    const fixture = { role, pane, file }; fixtures.push(fixture);
    await until(() => Boolean(record(file)?.exitControl), role + " must register its actual IPC endpoint");
    assert.ok(alive(pane), role + " must be a live real Pi process");
    writeFileSync(join(dir, role + "-startup.txt"), capture(pane));
    return fixture;
  };
  t.after(async () => {
    // Cleanup is scoped to this unique socket and these disposable Pi processes.
    for (const fixture of fixtures) {
      try { if (alive(fixture.pane)) writeFileSync(join(dir, fixture.role + ".quit"), "cleanup\n"); } catch {}
    }
    try { await until(() => fixtures.every(fixture => !alive(fixture.pane)), "fixture self-cleanup", 5000); }
    finally { try { tmux(["kill-server"]); } catch {} }
  });

  const target = await launch("target"), host = await launch("host");
  const initial = record(target.file)!;
  command(target.pane, "/reload");
  await until(() => Boolean(record(target.file)?.exitControl && record(target.file)!.exitControl!.token !== initial.exitControl!.token), "real /reload must replace instance credentials");
  const reloaded = record(target.file)!;
  assert.equal(reloaded.pid, initial.pid, "/reload is not a process restart");
  assert.equal(existsSync(initial.exitControl!.endpoint), false);
  assert.throws(() => stopRegisteredSession(registry, rowFromRecord(initial)), /registration changed/);
  await assert.rejects(requestExit({ ...reloaded.exitControl!, token: "stale-fixture-token" }, { pid: reloaded.pid, sessionFile: target.file }), /instance changed/);
  assert.ok(alive(target.pane), "stale credentials must not exit the target");
  assert.ok(events("target").some(event => event.event === "session_start" && event.reason === "reload"));
  writeFileSync(join(dir, "target-after-reload.txt"), capture(target.pane));

  command(host.pane, "/sessions");
  await until(() => capture(host.pane).includes("Sessions") && capture(host.pane).includes("E2E target"), "real production panel must display the target");
  tmux(["send-keys", "-t", host.pane, "Home"]);
  await until(() => /❯\s+○\s+E2E target/.test(capture(host.pane)), "the selected Idle row must be the fixture target");
  writeFileSync(join(dir, "panel-before-x.txt"), capture(host.pane));
  tmux(["send-keys", "-t", host.pane, "-l", "x"]);
  await until(() => !alive(target.pane), "real panel X must let target Pi exit itself");
  assert.equal(tmux(["display-message", "-p", "-t", target.pane, "#{pane_dead_status}"]), "0");
  assert.equal(record(target.file), undefined);
  assert.equal(existsSync(reloaded.exitControl!.endpoint), false);
  assert.ok(alive(host.pane), "host Pi must remain alive");
  assert.ok(events("target").some(event => event.event === "session_shutdown"));
  await until(() => capture(host.pane).includes("Closed"), "the real panel must show Closed after accepted exit");
  writeFileSync(join(dir, "panel-after-x.txt"), capture(host.pane));

  const busy = await launch("busy");
  command(busy.pane, "Hold this isolated run before its model request");
  await until(() => events("busy").some(event => event.event === "held_before_model"), "real run must reach the pre-model busy boundary");
  const busyRecord = record(busy.file)!;
  assert.equal(events("busy").find(event => event.event === "held_before_model").idle, false);
  await assert.rejects(Promise.resolve(stopRegisteredSession(registry, rowFromRecord(busyRecord))), /no longer idle/);
  assert.ok(alive(busy.pane), "busy target must survive the refused exit request");
  writeFileSync(join(dir, "busy-target.txt"), capture(busy.pane));
  writeFileSync(join(dir, "busy.quit"), "abort fixture before provider and quit\n");
  await until(() => !alive(busy.pane), "held fixture must abort before its provider and then quit normally");
  assert.equal(tmux(["display-message", "-p", "-t", busy.pane, "#{pane_dead_status}"]), "0");
  assert.ok(events("busy").some(event => event.event === "session_shutdown"));
  assert.equal(record(busy.file), undefined);

  for (const fixture of fixtures) {
    assert.ok(!events(fixture.role).some(event => event.event.startsWith("forbidden_")), "no model/provider call may occur");
  }
  const result = { ok: true, pi, platform: process.platform, targetPid: reloaded.pid, hostPid: record(host.file)!.pid,
    checks: ["real-tui-idle-x", "real-target-shutdown-exit-0", "registry-and-endpoint-cleanup", "real-reload-new-credentials-same-pid", "stale-row-and-token-refusal", "real-pre-model-busy-refusal", "no-model-calls"],
    limits: "Busy is a real Pi run held in before_agent_start before any provider request; it is not a completed streaming model turn. The held fixture is aborted before its first provider call and then quits through the normal Pi shutdown path." };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
});
