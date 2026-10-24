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
import { cleanTitle, firstUserText, createNamer, resolveModel } from "../extension/naming.ts";
import { readConfig } from "../extension/config.ts";
import { mkdtempSync as mkdtemp2, writeFileSync as writeFile2 } from "node:fs";
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

test("cleanTitle strips quotes, punctuation and runaway length", () => {
  assert.equal(cleanTitle('"Refactor the session registry."'), "Refactor the session registry");
  assert.equal(cleanTitle("  多个   空格  "), "多个 空格");
  assert.equal(cleanTitle("滑点模型偏高。"), "滑点模型偏高");
  assert.equal(cleanTitle("x".repeat(200)).length, 60);
  assert.equal(cleanTitle("   "), "");
});

test("firstUserText takes the first non-empty user line on the branch", () => {
  const branch = [
    { type: "message", message: { role: "system", content: "" } },
    { type: "message", message: { role: "user", content: "\n\n  first real line  \nsecond" } },
    { type: "message", message: { role: "user", content: "later" } },
  ];
  const context = { sessionManager: { getBranch: () => branch } } as any;
  assert.equal(firstUserText(context), "first real line");
  assert.equal(firstUserText({ sessionManager: { getBranch: () => [] } } as any), undefined);

  // The namer relies on this: an unusable message must yield undefined, not "".
  for (const content of ["", "   \n  ", [], [{ type: "image" }]]) {
    const ctx = { sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content } }] } } as any;
    assert.equal(firstUserText(ctx), undefined, `content ${JSON.stringify(content)} must yield undefined`);
  }
});

test("the namer does nothing without a configured model", async () => {
  let calls = 0;
  const namer = createNamer({
    pi: { setSessionName: () => calls++ } as any,
    model: () => undefined,
  });
  const context = {
    sessionManager: {
      getSessionName: () => undefined,
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" } }],
    },
    modelRegistry: { find: () => undefined, complete: async () => ({ content: [] }) },
  } as any;
  await namer(context);
  assert.equal(calls, 0, "no model configured means no call and no name");
});

test("the namer leaves an already-named session alone", async () => {
  let completed = 0;
  const namer = createNamer({
    pi: { setSessionName: () => {} } as any,
    model: () => "magpie/glm-5.3-flash",
  });
  const context = {
    sessionManager: {
      getSessionName: () => "already named",
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" } }],
    },
    modelRegistry: {
      find: () => ({ id: "glm-5.3-flash" }),
      complete: async () => { completed++; return { content: [] }; },
    },
  } as any;
  await namer(context);
  assert.equal(completed, 0, "must not spend a model call on a named session");
});

test("concurrent triggers spend one model call and write one name", async () => {
  const names: string[] = [];
  let calls = 0;
  const namer = createNamer({
    pi: { setSessionName: (n: string) => names.push(n) } as any,
    model: () => "magpie/glm-5.3-flash",
  });
  const context = {
    sessionManager: {
      getSessionName: () => undefined,
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" } }],
    },
    modelRegistry: {
      find: () => ({ id: "glm-5.3-flash" }),
      complete: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return { content: [{ type: "text", text: "A short name" }] };
      },
    },
  } as any;

  await Promise.all([namer(context), namer(context), namer(context)]);
  assert.equal(calls, 1, "the in-flight guard must collapse concurrent triggers");
  assert.deepEqual(names, ["A short name"]);
});

test("a failed naming attempt is retried next time", async () => {
  const names: string[] = [];
  let attempt = 0;
  const namer = createNamer({
    pi: { setSessionName: (n: string) => names.push(n) } as any,
    model: () => "magpie/glm-5.3-flash",
  });
  const context = {
    sessionManager: {
      getSessionName: () => undefined,
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" } }],
    },
    modelRegistry: {
      find: () => ({ id: "glm-5.3-flash" }),
      complete: async () => {
        attempt++;
        if (attempt === 1) throw new Error("network");
        return { content: [{ type: "text", text: "Second time works" }] };
      },
    },
  } as any;

  await namer(context);
  assert.deepEqual(names, [], "a failure must not write a name");
  await namer(context);
  assert.deepEqual(names, ["Second time works"], "the retry must succeed");
});

/** A registry stub with a few models, shaped like the real one. */
function fakeRegistry(models: { provider: string; id: string }[]) {
  return {
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    getModelsOfType: () => models,
  } as any;
}

test("a bare model id resolves without a provider prefix", () => {
  const registry = fakeRegistry([
    { provider: "magpie", id: "auto/glm-5.3-flash" },
    { provider: "magpie", id: "auto/deepseek-flash" },
  ]);
  const result = resolveModel(registry, "glm-5.3-flash");
  assert.ok("model" in result, "a suffix must be enough");
  assert.equal(result.model!.id, "auto/glm-5.3-flash");
});

test("an ambiguous id reports the candidates instead of guessing", () => {
  // Suffix ambiguity with no preference given.
  const registry = fakeRegistry([
    { provider: "a", id: "auto/glm-5.3-flash" },
    { provider: "b", id: "opencode-go/glm-5.3-flash" },
  ]);
  const result = resolveModel(registry, "glm-5.3-flash");
  assert.ok("error" in result);
  assert.match(result.error, /matches 2 models/);
  assert.match(result.error, /auto\/glm-5\.3-flash/);
});

test("an ambiguous id resolves to the preferred provider", () => {
  const registry = fakeRegistry([
    { provider: "a", id: "auto/glm-5.3-flash" },
    { provider: "b", id: "opencode-go/glm-5.3-flash" },
  ]);
  // No preference: ambiguous. With a preference: resolved, no config needed.
  assert.ok("error" in resolveModel(registry, "glm-5.3-flash"));
  const result = resolveModel(registry, "glm-5.3-flash", ["", "b"]);
  assert.ok("model" in result);
  assert.equal(result.model!.provider, "b");
});

test("an unknown model reports an error rather than resolving to nothing", () => {
  const result = resolveModel(fakeRegistry([{ provider: "a", id: "other" }]), "nope");
  assert.ok("error" in result);
  assert.match(result.error, /no model matches/);
});

test("a full provider/id still wins over suffix matching", () => {
  const registry = fakeRegistry([
    { provider: "a", id: "glm-5.3-flash" },
    { provider: "b", id: "glm-5.3-flash" },
  ]);
  const result = resolveModel(registry, "b/glm-5.3-flash");
  assert.ok("model" in result);
  assert.equal(result.model!.provider, "b");
});

test("config accepts a bare string or the object form", () => {
  const dir = mkdtemp2(join(tmpdir(), "panel-config-"));
  mkdirSync(join(dir, "session-panel"), { recursive: true });

  writeFile2(join(dir, "session-panel", "config.json"), "glm-5.3-flash\n");
  assert.deepEqual(readConfig(dir), { titleModel: "glm-5.3-flash" }, "bare string");

  writeFile2(join(dir, "session-panel", "config.json"), '{ "titleModel": "x/y" }');
  assert.deepEqual(readConfig(dir), { titleModel: "x/y" }, "object form");

  writeFile2(join(dir, "session-panel", "config.json"), "");
  assert.deepEqual(readConfig(dir), {}, "empty means off");

  writeFile2(join(dir, "session-panel", "config.json"), "{ broken json");
  assert.deepEqual(readConfig(dir), {}, "broken json means off, not a crash");
});

test("a broken model config is reported once, not on every prompt", async () => {
  const reasons: string[] = [];
  const namer = createNamer({
    pi: { setSessionName: () => {} } as any,
    model: () => "does-not-exist",
    onBroken: (r) => reasons.push(r),
  });
  const context = {
    sessionManager: {
      getSessionName: () => undefined,
      getBranch: () => [{ type: "message", message: { role: "user", content: "hello" } }],
    },
    modelRegistry: fakeRegistry([{ provider: "a", id: "other" }]),
  } as any;

  await namer(context);
  await namer(context);
  await namer(context);
  assert.equal(reasons.length, 1, "one warning per process is enough");
  assert.match(reasons[0]!, /no model matches/);
});
