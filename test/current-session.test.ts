import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionsPanel } from "../extension/panel.ts";
import { rowFromRecord } from "../extension/live.ts";
import type { SessionRow } from "../extension/types.ts";

const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text };
const backgrounds: { token: string; text: string }[] = [];
const painted = { ...theme, bg: (token: string, text: string) => { backgrounds.push({ token, text }); return text; } };
const currentBackground = () => backgrounds.filter(({ token }) => token === "customMessageBg");
const row = (key: string, current = false): SessionRow => ({ key, name: key, state: "idle", cwd: "/tmp/test", updatedAt: 100, current });
const panel = (rows: () => SessionRow[]) => new SessionsPanel({ rows, close() {}, actions: {
  focus() {}, interrupt() {}, exit() {}, remove() {}, reopen() {}, rename() {}, rescan() {},
} });

test("current identity follows the host process or resumed session file, not cwd or title", () => {
  const host = { pid: 10, sessionFile: "/sessions/restored.jsonl" };
  const record = { pid: 20, name: "same title", cwd: "/tmp/same", state: "idle" as const, updatedAt: 1 };
  assert.equal(rowFromRecord({ ...record, pid: 10 }, host).current, true);
  assert.equal(rowFromRecord({ ...record, sessionFile: host.sessionFile }, host).current, true);
  assert.equal(rowFromRecord({ ...record, sessionFile: "/sessions/other.jsonl" }, host).current, false);
  assert.equal(rowFromRecord(record, { pid: 10 }).current, false, "two missing files are not the same session");
});

test("current row is initially visible and keeps a distinct full-width background after the cursor moves", async () => {
  const rows = [row("other"), row("here", true)];
  const view = panel(() => rows);
  backgrounds.length = 0;
  const first = view.render(painted, 80, 10);
  assert.match(first.find(line => line.includes("here"))!, /❯ · here/);
  assert.ok(!first.join("\n").includes("[current]"));
  assert.match(currentBackground()[0]!.text, /^❯ · here/);
  assert.equal(currentBackground().length, 1);
  assert.equal(visibleWidth(currentBackground()[0]!.text), 76);
  assert.equal(view.selectedKey(), "here");
  await view.handleInput("k");
  backgrounds.length = 0;
  const lines = view.render(painted, 80, 10);
  assert.equal(view.selectedKey(), "other");
  assert.match(lines.find(line => line.includes("here"))!, /· here/);
  assert.ok(!lines.find(line => line.includes("here"))!.includes("❯"));
  assert.ok(lines.find(line => line.includes("other"))!.includes("❯"));
  assert.equal(currentBackground().length, 1);
  assert.match(currentBackground()[0]!.text, /here/);
  assert.ok(backgrounds.some(({ token, text }) => token === "selectedBg" && text.includes("other")));
  assert.ok(!backgrounds.some(({ token, text }) => token === "selectedBg" && text.includes("here")));
});

test("a long current title keeps its full-row background on narrow panels in either live state", () => {
  for (const state of ["working", "idle"] as const) {
    const rows = [row("a very long current session title", true)];
    rows[0]!.state = state;
    const view = panel(() => rows);
    backgrounds.length = 0;
    const lines = view.render(painted, 24, 9);
    assert.equal(currentBackground().length, 1);
    assert.equal(visibleWidth(currentBackground()[0]!.text), 20);
    assert.ok(lines.every(line => visibleWidth(line) <= 24));
  }
});

test("opening a short panel scrolls the current Idle session into view below Working rows", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ ...row(`worker-${index}`), state: "working" as const }));
  const view = panel(() => [...rows, row("here", true)]);
  const text = view.render(theme, 80, 9).join("\n");
  assert.match(text, /❯ · here/);
  assert.equal(view.selectedKey(), "here");
});

test("a current-only change invalidates the frame cache without moving the cursor", t => {
  t.mock.method(Date, "now", () => 123456);
  const rows = [row("other"), row("here")];
  const view = panel(() => rows);
  backgrounds.length = 0;
  view.render(painted, 80, 10);
  assert.equal(currentBackground().length, 0);
  rows[1]!.current = true;
  backgrounds.length = 0;
  view.render(painted, 80, 10);
  assert.equal(currentBackground().length, 1);
  assert.match(currentBackground()[0]!.text, /here/);
  assert.equal(view.selectedKey(), "other");
  rows[1]!.current = false;
  backgrounds.length = 0;
  view.render(painted, 80, 10);
  assert.equal(currentBackground().length, 0);
});

test("searching another session does not transfer the current background to it", async () => {
  const view = panel(() => [row("other"), row("here", true)]);
  view.render(theme, 80, 10);
  await view.handleInput("/");
  for (const key of "other") await view.handleInput(key);
  backgrounds.length = 0;
  const text = view.render(painted, 80, 10).join("\n");
  assert.ok(text.includes("other"));
  assert.equal(currentBackground().length, 0);
});
