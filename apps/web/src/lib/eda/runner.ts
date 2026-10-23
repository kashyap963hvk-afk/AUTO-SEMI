import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { StageResult, type Job, type Stage } from "./contracts";
import { jobInputHash } from "./jobs";
import { wasmLint, wasmSynth } from "./wasmYosys";

/**
 * Chooses how a stage is executed, in order of preference:
 *  1. live-worker: a configured EDA worker (WORKER_URL + WORKER_TOKEN) runs the real tools now;
 *  2. recorded:    evidence from an earlier real run whose input hash matches exactly;
 *  3. live-wasm:   Yosys compiled to WebAssembly in this process (lint-elaboration, synthesis);
 *  4. unavailable: an explicit BLOCKED_TOOL_UNAVAILABLE result. Nothing is ever fabricated.
 */

export interface RunnerInfo {
  worker: { configured: boolean; url: string | null };
  recordedEvidence: number;
  wasm: string[];
}

export function evidenceDir(): string {
  return process.env.DEVIN_EVIDENCE_DIR ?? path.join(process.cwd(), "evidence");
}

export function loadRecorded(hash: string): StageResult | null {
  if (process.env.DEVIN_DISABLE_RECORDED === "1" || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const file = path.join(evidenceDir(), `${hash}.json`);
  if (!existsSync(file)) return null;
  const parsed = StageResult.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success || parsed.data.input_hash !== hash) return null;
  const original = parsed.data.execution;
  return {
    ...parsed.data,
    execution: {
      ...original,
      mode: "recorded",
      recorded_from: original.mode,
      note: "Reused from a real tool run whose job inputs (sources, tests, parameters, options) have the identical SHA-256. The tools were not re-run now.",
    },
  };
}

async function callWorker(job: Job): Promise<StageResult> {
  const url = process.env.WORKER_URL!.replace(/\/$/, "");
  const res = await fetch(`${url}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.WORKER_TOKEN}` },
    body: JSON.stringify({ ...job, limits: { timeout_s: 240, memory_mb: 2048, max_output_bytes: 200000 } }),
    redirect: "error",
    signal: AbortSignal.timeout(280_000),
  });
  if (!res.ok) throw new Error(`worker returned HTTP ${res.status}`);
  const parsed = StageResult.parse(await res.json());
  if (parsed.input_hash !== jobInputHash(job)) throw new Error("worker result input hash does not match the submitted job");
  return parsed;
}

function unavailable(job: Job, why: string, status: StageResult["status"] = "BLOCKED_TOOL_UNAVAILABLE", code = "TOOL_UNAVAILABLE"): StageResult {
  const now = new Date().toISOString();
  return {
    schema_version: "1.0",
    job_id: job.job_id,
    stage: job.stage,
    status,
    summary: `${job.stage} not run: ${why}`,
    input_hash: jobInputHash(job),
    started_at: now,
    finished_at: now,
    duration_s: 0,
    execution: { mode: "unavailable" },
    steps: [],
    findings: [{ severity: "error", code, message: why, tool: "runner" }],
    tests: [],
    properties: [],
    formal_status: job.stage === "formal" ? "NOT_RUN" : null,
    metrics: {},
    artifacts: [],
    limitations: [],
  };
}

export function workerConfigured(): boolean {
  return Boolean(process.env.WORKER_URL && process.env.WORKER_TOKEN);
}

export async function runStage(job: Job): Promise<StageResult> {
  const hash = jobInputHash(job);
  if (job.stage === "physical") {
    const o = job.options as { clock_period_ns?: number | null; constraints_approved?: boolean; platform?: string | null };
    if (!o.clock_period_ns || !o.constraints_approved) {
      return unavailable(job, "clock period is unknown or the SDC draft has not been approved", "BLOCKED_MISSING_CONSTRAINTS", "TIMING_CONSTRAINTS_INCOMPLETE");
    }
    if (!o.platform || o.platform === "undecided") return unavailable(job, "target PDK is not confirmed", "BLOCKED_MISSING_CONSTRAINTS", "PDK_UNCONFIRMED");
  }
  if (workerConfigured()) {
    try {
      return await callWorker(job);
    } catch (e) {
      const recorded = loadRecorded(hash);
      if (recorded) return recorded;
      return unavailable(job, `EDA worker unreachable or returned an invalid result (${(e as Error).message})`);
    }
  }
  const recorded = loadRecorded(hash);
  if (recorded) return recorded;
  if (process.env.DEVIN_DISABLE_WASM !== "1") {
    if (job.stage === "lint") return wasmLint(job);
    if (job.stage === "synthesis") return wasmSynth(job);
  }
  const why: Record<Stage, string> = {
    lint: "no EDA worker is connected and no recorded run matches these inputs",
    simulation: "no EDA worker (cocotb + Icarus) is connected and no recorded run matches these exact inputs",
    formal: "no EDA worker (SymbiYosys + z3) is connected and no recorded run matches these exact inputs",
    synthesis: "no EDA worker is connected and no recorded run matches these inputs",
    physical: "OpenROAD Flow Scripts and PDK collateral are not installed on any connected worker",
  };
  return unavailable(job, why[job.stage]);
}
