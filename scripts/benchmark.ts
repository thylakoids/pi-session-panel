import { performance } from "node:perf_hooks";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Pass another checkout to run identical workloads against an earlier version.
const root = resolve(process.argv[2] ?? ".");
const moduleAt = (file: string) => import(pathToFileURL(resolve(root, "extension", file)).href);
const { SessionsPanel } = await moduleAt("panel.ts");
const { readRegistry, writeRecord } = await moduleAt("registry.ts");
const { rowFromRecord, createRowsSource } = await moduleAt("live.ts");
const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
let now = 1_700_000_000_000;
Date.now = () => now;
const noop = () => {};
const actions = { focus: noop, reopen: noop, interrupt: noop, exit: noop, remove: noop, rename: noop, rescan: noop };
const results: Record<string, unknown>[] = [];
const registry = mkdtempSync(join(tmpdir(), "panel-benchmark-"));
const sources = readdirSync(resolve(root, "extension")).filter(file => file.endsWith(".ts"))
  .map(file => readFileSync(resolve(root, "extension", file), "utf8"));
const sourceLines = sources.reduce((sum, text) => sum + text.split("\n").length - 1, 0);
const sourceBytes = sources.reduce((sum, text) => sum + Buffer.byteLength(text), 0);

async function measure(name: string, count: number, run: () => unknown) {
  for (let i = 0; i < 50; i++) await run();
  const samples: number[] = [];
  for (let round = 0; round < 7; round++) {
    const start = performance.now();
    for (let i = 0; i < count; i++) await run();
    samples.push((performance.now() - start) * 1000 / count);
  }
  samples.sort((a, b) => a - b);
  return { workload: name, medianUs: +samples[3]!.toFixed(2), slowestBatchUs: +samples[6]!.toFixed(2) };
}

try {
  writeRecord(registry, { pid: process.pid, cwd: "/tmp/benchmark", name: "Live benchmark", state: "working", updatedAt: now, workingSince: now });
  for (const size of [200, 2000]) {
    const rows = Array.from({ length: size }, (_, i) => ({
      key: "closed:" + i, state: "closed", name: "Session " + i + " 缓存与渲染", cwd: "/tmp/project-" + (i % 12),
      updatedAt: now - i * 60_000, searchText: "Session " + i + " cache renderer benchmark",
    }));
    const panel = new SessionsPanel({ rows: () => [...rows], actions, close: noop });
    panel.render(theme, 100, 30);
    results.push({ rows: size, ...await measure("unchanged poll + cached render", 500, () => {
      panel.needsRedraw(theme, 100, 30); panel.render(theme, 100, 30);
    }) });
    let down = true;
    results.push({ rows: size, ...await measure("move + render", 100, async () => {
      await panel.handleInput(down ? "j" : "k"); down = !down; panel.render(theme, 100, 30);
    }) });
    await panel.handleInput("/");
    await panel.handleInput("cache");
    results.push({ rows: size, ...await measure("filtered move + render", 100, async () => {
      await panel.handleInput(down ? "\x1b[B" : "\x1b[A"); down = !down; panel.render(theme, 100, 30);
    }) });
    results.push({ rows: size, ...await measure("search edit + render", 100, async () => {
      await panel.handleInput(down ? "\x7f" : "e"); down = !down; panel.render(theme, 100, 30);
    }) });
    panel.dispose();
    // Use production snapshots when supported; older checkouts use their original callback path.
    const source = typeof createRowsSource === "function"
      ? createRowsSource(() => readRegistry(registry).live, () => rows) : undefined;
    source?.refresh();
    const withRegistry = new SessionsPanel({
      rows: () => source ? source.rows : [...readRegistry(registry).live.map((record: any) => rowFromRecord(record)), ...rows],
      ...(source ? { rowsVersion: () => source.version } : {}), actions, close: noop,
    });
    withRegistry.render(theme, 100, 30);
    results.push({ rows: size, ...await measure("registry read + redraw gate", 200, () => {
      source?.refresh();
      return withRegistry.needsRedraw(theme, 100, 30);
    }) });
    results.push({ rows: size, ...await measure("registry + spinner tick + render", 100, () => {
      now += 100;
      source?.refresh();
      if (withRegistry.needsRedraw(theme, 100, 30)) withRegistry.render(theme, 100, 30);
    }) });
    results.push({ rows: size, ...await measure("production cached render", 1000, () => withRegistry.render(theme, 100, 30)) });
    results.push({ rows: size, ...await measure("production move + render", 100, async () => {
      await withRegistry.handleInput(down ? "j" : "k"); down = !down;
      withRegistry.render(theme, 100, 30);
    }) });
    withRegistry.dispose();
  }
} finally { rmSync(registry, { recursive: true, force: true }); }
console.log(JSON.stringify({ root, sourceLines, sourceBytes, node: process.version, unit: "microseconds per operation; seven batches after warmup", results }, null, 2));
