/**
 * Tests for the panel, the registry and the search.
 *
 * Each case here was written by breaking the code first and confirming the test
 * failed, so none of them are decorative.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionsPanel } from "../extension/panel.ts";
import { readRegistry, writeRecord, removeRecord } from "../extension/registry.ts";
import { insertClosed } from "../extension/closed.ts";
import { parseSearch, matchSearch } from "../extension/search.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const theme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
  style: (s: string) => s,
  colors: {},
  appearance: "dark",
};

function row(over: Record<string, unknown> = {}) {
  return {
    key: "live:1",
    state: "idle" as const,
    name: "session one",
    cwd: "/tmp/one",
    updatedAt: Date.now(),
    ...over,
  };
}

function panel(rows: () => any[], actions: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const instance = new SessionsPanel({
    rows,
    close: () => calls.push("close"),
    notify: () => {},
    actions: {
      focus: () => calls.push("focus"),
      reopen: () => calls.push("reopen"),
      interrupt: () => calls.push("interrupt"),
      exit: () => calls.push("exit"),
      remove: () => calls.push("remove"),
      rename: () => calls.push("rename"),
      rescan: () => calls.push("rescan"),
      ...actions,
    } as any,
  });
  return { instance, calls };
}

/** Last visible character of a styled line. */
function lastChar(line: string): string {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  return [...plain].at(-1) ?? "";
}

/**
 * The frame must be exactly `width` columns wide *and* closed: every interior
 * line ends on the right border, and the corners sit in the last column. Equal
 * widths alone do not prove that, because the final padding hides a short border.
 */
function assertWidths(lines: string[], width: number) {
  for (const [index, line] of lines.entries()) {
    assert.equal(visibleWidth(line), width, `line ${index} is not ${width} wide`);
  }
  assert.equal(lastChar(lines[0]!), "╮", "top border must close");
  assert.ok(!/[─╭]  +/.test(lines[0]!) && !/  +[─╮]/.test(lines[0]!), "top border must have no gap");
  assert.equal(lastChar(lines.at(-1)!), "╯", "bottom border must close");
  for (const [index, line] of lines.slice(1, -1).entries()) {
    assert.equal(lastChar(line), "│", `interior line ${index + 1} must end on the border`);
  }
}

test("every line is exactly the requested width", () => {
  const { instance } = panel(() => [row()]);
  for (const width of [40, 72, 100, 121]) {
    assertWidths(instance.render(theme, width, 20), width);
  }
});

test("a CJK session name does not shift the right-hand columns", () => {
  const rows = [
    row({ key: "live:1", name: "为什么回测的滑点模型偏高", cwd: "/Users/x/FutTrader" }),
    row({ key: "live:2", name: "short", cwd: "/Users/x/Blog" }),
  ];
  const { instance } = panel(() => rows);
  const lines = instance.render(theme, 100, 20);
  assertWidths(lines, 100);

  // The right-hand block is two fixed columns, so every row's folder must start at
  // the same terminal column regardless of how wide the name before it is.
  const starts = lines
    .filter((line) => line.includes("FutTrader") || line.includes("Blog"))
    .map((line) => visibleWidth(line.slice(0, line.search(/FutTrader|Blog/))));
  assert.equal(starts.length, 2, "both rows must be found");
  assert.equal(starts[0], starts[1], "folder column must be aligned");
});

test("X interrupts a working row, exits an idle row, and confirms for a closed row", async () => {
  const rows = [
    row({ key: "live:1", state: "working", workingSince: Date.now() - 1000 }),
    row({ key: "live:2", state: "idle" }),
    row({ key: "closed:/tmp/x.jsonl", state: "closed", sessionFile: "/tmp/x.jsonl" }),
  ];
  const { instance, calls } = panel(() => rows);
  instance.render(theme, 100, 20);

  await instance.handleInput("X");
  assert.deepEqual(calls, ["interrupt"], "working row must interrupt");

  await instance.handleInput("j");
  await instance.handleInput("X");
  assert.deepEqual(calls, ["interrupt", "exit"], "idle row must exit");

  await instance.handleInput("j");
  await instance.handleInput("X");
  assert.deepEqual(calls, ["interrupt", "exit"], "closed row must not act before confirmation");

  await instance.handleInput("j");
  await instance.handleInput("\r");
  assert.deepEqual(calls, ["interrupt", "exit", "remove"], "confirming must delete");
});

test("Enter reopens a closed session instead of replacing this one", async () => {
  const rows = [
    row({ key: "live:1", state: "working", workingSince: Date.now() - 1000 }),
    row({ key: "closed:/tmp/x.jsonl", state: "closed", sessionFile: "/tmp/x.jsonl" }),
  ];
  const { instance, calls } = panel(() => rows);
  instance.render(theme, 100, 20);

  await instance.handleInput("j");
  await instance.handleInput("\r");

  // Reopening must never just navigate: it has to leave this session untouched.
  assert.deepEqual(calls, ["reopen", "close"], "Enter on closed must reopen and close");
});

test("Enter on a live row jumps to its pane", async () => {
  const { instance, calls } = panel(() => [row({ state: "working", workingSince: Date.now() - 1000 })]);
  instance.render(theme, 100, 20);
  await instance.handleInput("\r");
  assert.deepEqual(calls, ["focus", "close"]);
});

test("R rescans and / searches", async () => {
  const { instance, calls } = panel(() => [row()]);
  instance.render(theme, 100, 20);
  await instance.handleInput("R");
  assert.deepEqual(calls, ["rescan"]);
  await instance.handleInput("/");
  await instance.handleInput("x");
  instance.render(theme, 100, 20);
  // The search box must show the query.
  assert.ok(instance.render(theme, 100, 20).some((l) => l.includes("Search: x")));
});

test("search matches the way pi -r does: fuzzy tokens, quoted phrases, re:", () => {
  const haystack = "abc123 my session 讨论滑点 src/slippage.py";

  assert.ok(matchSearch(haystack, parseSearch("slip")).matches, "fuzzy substring");
  assert.ok(matchSearch(haystack, parseSearch("slippage")).matches, "fuzzy word");
  assert.ok(!matchSearch(haystack, parseSearch("zzz")).matches, "no false match");

  assert.ok(matchSearch(haystack, parseSearch('"讨论滑点"')).matches, "quoted phrase");
  assert.ok(!matchSearch(haystack, parseSearch('"滑点讨论"')).matches, "phrase is ordered");
  // "foo baz" is a subsequence of "foo bar baz", so fuzzy would match it; a quoted
  // phrase must not, because the words are not adjacent.
  assert.ok(matchSearch("foo bar baz", parseSearch("foo baz")).matches, "fuzzy tolerates gaps");
  assert.ok(!matchSearch("foo bar baz", parseSearch('"foo baz"')).matches, "phrase does not");

  assert.ok(matchSearch(haystack, parseSearch("re:src/.*\\.py")).matches, "regex");
  assert.ok(!matchSearch(haystack, parseSearch("re:^zzz")).matches, "regex anchored");

  assert.ok(parseSearch("re:[").error, "invalid regex reports an error");
});

test("the registry drops records whose process is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-registry-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 150));

  writeRecord(dir, { pid: child.pid!, cwd: "/tmp", state: "working", workingSince: 1, updatedAt: 2 });
  writeRecord(dir, { pid: process.pid, cwd: "/here", state: "idle", updatedAt: 3 });

  let read = readRegistry(dir);
  assert.equal(read.live.length, 2, "both live processes are reported");

  child.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 300));

  read = readRegistry(dir);
  assert.equal(read.live.length, 1, "the dead one is dropped");
  assert.equal(read.cleaned.length, 1, "and reported as cleaned");

  removeRecord(dir, process.pid);
  // Check the directory first: readRegistry() heals leftover directories as a side
  // effect, so asking it first would make this assertion pass no matter what.
  assert.deepEqual(readdirSync(dir), [], "no leftover directories after a clean exit");
  assert.equal(readRegistry(dir).live.length, 0);
});

test("a corrupt registry record is discarded instead of crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-registry-"));
  mkdirSync(join(dir, "999999"), { recursive: true });
  writeFileSync(join(dir, "999999", "record.json"), "{not json");
  const read = readRegistry(dir);
  assert.equal(read.live.length, 0);
  assert.ok(!readdirSync(dir).includes("999999"), "the broken directory is removed");
});

test("inserting into the closed index keeps it ordered and free of duplicates", () => {
  const index = {
    rows: [
      row({ key: "closed:a", state: "closed", updatedAt: 300 }),
      row({ key: "closed:b", state: "closed", updatedAt: 100 }),
    ],
    loadedAt: 0,
  };
  const next = insertClosed(index, row({ key: "closed:c", state: "closed", updatedAt: 200 }));
  assert.deepEqual(next.rows.map((r) => r.key), ["closed:a", "closed:c", "closed:b"]);

  const again = insertClosed(next, row({ key: "closed:c", state: "closed", updatedAt: 200 }));
  assert.equal(again.rows.length, 3, "re-inserting must not duplicate");
});

test("the redraw gate stays quiet when nothing changed", () => {
  // updatedAt is fixed on purpose: if it followed the mocked clock, the data
  // signature would change and the gate would report a redraw for the wrong
  // reason, which is exactly the bug this test exists to catch.
  const fixed = row({ updatedAt: 1_700_000_000_000 });
  const { instance } = panel(() => [fixed]);
  const realNow = Date.now;
  try {
    const base = 1_700_000_000_000;
    Date.now = () => base;
    instance.render(theme, 100, 20);
    assert.equal(instance.needsRedraw(theme, 100, 20), false, "same instant must not redraw");

    // 2000ms is exactly one spinner period, so the glyph is unchanged here and
    // only the second term can make the frame differ.
    Date.now = () => base + 2000;
    assert.equal(instance.needsRedraw(theme, 100, 20), true, "a new second must redraw");
  } finally {
    Date.now = realNow;
  }
});
