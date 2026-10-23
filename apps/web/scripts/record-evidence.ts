/**
 * Runs the real EDA worker over a grid of FIFO configurations and stores each result
 * under evidence/<job input sha256>.json. The web app reuses a result only when a job's
 * inputs hash identically, and labels it "recorded". Usage:
 *   npm run evidence:record -- [--grid default|full] [--jobs 4]
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { generateFilelist, generateProps, generateRtl, generateSdc, type DemoDefect } from "../src/lib/design/fifoTemplate";
import type { FifoConfig, ResetStyle } from "../src/lib/domain/fifo";
import { buildJob } from "../src/lib/eda/jobs";
import { jobInputHash } from "../src/lib/eda/jobs";
import type { Job, Stage } from "../src/lib/eda/contracts";

const run = promisify(execFile);
const root = path.resolve(__dirname, "../../..");
const outDir = path.resolve(__dirname, "../evidence");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const grid = arg("grid", "default");
const parallel = Number(arg("jobs", "4"));
const configs: { cfg: FifoConfig; defects: DemoDefect[] }[] = [];
const base: FifoConfig = { WIDTH: 8, DEPTH: 16, RESET: "sync_active_low", ALLOW_WRITE_WHEN_FULL_WITH_READ: true };
configs.push({ cfg: base, defects: [] }, { cfg: base, defects: ["full_off_by_one"] });
if (grid === "full") {
  for (const WIDTH of [8, 16, 32])
    for (const DEPTH of [4, 8, 16, 32])
      for (const RESET of ["sync_active_low", "sync_active_high", "async_active_low"] as ResetStyle[])
        for (const ALLOW of [true, false]) configs.push({ cfg: { WIDTH, DEPTH, RESET, ALLOW_WRITE_WHEN_FULL_WITH_READ: ALLOW }, defects: [] });
}

const STAGES: Stage[] = ["lint", "simulation", "formal", "synthesis"];
/** Configurations that also get a real RTL-to-GDS run (needs ORFS on the worker): the demo designs. */
const PHYSICAL: { cfg: FifoConfig; clockMhz: number; platform: string }[] = [
  { cfg: base, clockMhz: 50, platform: "sky130hd" },
  { cfg: { WIDTH: 32, DEPTH: 32, RESET: "async_active_low", ALLOW_WRITE_WHEN_FULL_WITH_READ: true }, clockMhz: 200, platform: "sky130hd" },
];
const jobs = new Map<string, { job: Job; label: string }>();
for (const { cfg, defects } of configs) {
  const src = { "rtl/sync_fifo.sv": generateRtl(cfg, defects), "formal/sync_fifo_props.svh": generateProps(cfg), "rtl/filelist.f": generateFilelist() };
  for (const stage of STAGES) {
    const job = buildJob(stage, `rec-${stage}`, src, cfg);
    const hash = jobInputHash(job);
    if (!jobs.has(hash)) jobs.set(hash, { job, label: `${stage} W${cfg.WIDTH} D${cfg.DEPTH} ${cfg.RESET} rw=${cfg.ALLOW_WRITE_WHEN_FULL_WITH_READ}${defects.length ? ` defect=${defects}` : ""}` });
  }
}

if (process.argv.includes("--physical")) {
  for (const p of PHYSICAL) {
    const src = { "rtl/sync_fifo.sv": generateRtl(p.cfg), "formal/sync_fifo_props.svh": generateProps(p.cfg), "rtl/filelist.f": generateFilelist(), "constraints/approved.sdc": generateSdc(p.clockMhz) };
    const job = buildJob("physical", "rec-physical", src, p.cfg, { clockMhz: p.clockMhz, constraintsApproved: true, platform: p.platform });
    jobs.set(jobInputHash(job), { job: { ...job, limits: { timeout_s: 3600, memory_mb: 8192, max_output_bytes: 400000 } }, label: `physical W${p.cfg.WIDTH} D${p.cfg.DEPTH} ${p.cfg.RESET} @${p.clockMhz}MHz ${p.platform}` });
  }
}
mkdirSync(outDir, { recursive: true });
const indexPath = path.join(outDir, "index.json");
const index: Record<string, { label: string; status: string; summary: string; recorded_at: string }> = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : {};

/** Keep recorded logs reviewable but bounded. */
function trim(result: Record<string, unknown>) {
  const steps = (result.steps as { stdout: string; stderr: string; truncated: boolean }[]).map((s) => {
    const cut = (t: string) => (t.length > 24000 ? `${t.slice(0, 4000)}\n...[trimmed for the evidence store]...\n${t.slice(-20000)}` : t);
    return { ...s, stdout: cut(s.stdout), stderr: cut(s.stderr), truncated: s.truncated || s.stdout.length > 24000 || s.stderr.length > 24000 };
  });
  return { ...result, steps };
}

async function worker(queue: [string, { job: Job; label: string }][]) {
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    const [hash, { job, label }] = next;
    const file = path.join(outDir, `${hash}.json`);
    if (existsSync(file)) {
      const prev = JSON.parse(readFileSync(file, "utf8"));
      index[hash] = { label, status: prev.status, summary: prev.summary, recorded_at: prev.finished_at };
      console.log(`skip ${label} (exists)`);
      continue;
    }
    const jobFile = path.join(outDir, `.job-${hash}.json`);
    writeFileSync(jobFile, JSON.stringify(job));
    const { stdout } = await run("python3", ["-m", "devin_vlsi_worker", "run", jobFile], { cwd: path.join(root, "worker"), maxBuffer: 64 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    if (result.input_hash !== hash) throw new Error(`hash mismatch for ${label}: worker ${result.input_hash} vs web ${hash}`);
    writeFileSync(file, JSON.stringify(trim(result), null, 1) + "\n");
    (await import("node:fs")).unlinkSync(jobFile);
    index[hash] = { label, status: result.status, summary: result.summary, recorded_at: result.finished_at };
    console.log(`${result.status.padEnd(6)} ${label}: ${result.summary}`);
  }
}

(async () => {
  const queue = [...jobs.entries()];
  console.log(`${queue.length} unique jobs, ${parallel} in parallel`);
  await Promise.all(Array.from({ length: parallel }, () => worker(queue)));
  if (process.argv.includes("--prune")) {
    // Drop recordings no current job can match (e.g. after a template change).
    for (const f of (await import("node:fs")).readdirSync(outDir)) {
      const h = f.replace(/\.json$/, "");
      if (/^[0-9a-f]{64}$/.test(h) && !jobs.has(h)) {
        (await import("node:fs")).unlinkSync(path.join(outDir, f));
        delete index[h];
        console.log(`pruned ${h}`);
      }
    }
  }
  writeFileSync(indexPath, JSON.stringify(Object.fromEntries(Object.entries(index).sort()), null, 1) + "\n");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
