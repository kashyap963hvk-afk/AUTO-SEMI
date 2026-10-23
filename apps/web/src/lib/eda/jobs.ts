import { COCOTB_TEST_PATH, COCOTB_TEST_SOURCE } from "@/generated/designAssets";
import type { FifoConfig } from "../domain/fifo";
import { canonicalJson, sha256Json } from "../hash";
import type { Job, Stage } from "./contracts";

export const SIM_SEED = 20261023;

export interface SourceFiles {
  "rtl/sync_fifo.sv": string;
  "formal/sync_fifo_props.svh": string;
  "rtl/filelist.f": string;
  "constraints/approved.sdc"?: string;
}

export interface PhysicalContext {
  clockMhz: number | null;
  constraintsApproved: boolean;
  platform: string | null;
}

/** Build the worker job for one stage. Each stage receives only the inputs that can affect it. */
export function buildJob(stage: Stage, jobId: string, src: SourceFiles, cfg: FifoConfig, phys?: PhysicalContext): Job {
  const parameters = { WIDTH: cfg.WIDTH, DEPTH: cfg.DEPTH };
  const rtl = { "rtl/sync_fifo.sv": src["rtl/sync_fifo.sv"] };
  const base = { schema_version: "1.0" as const, job_id: jobId, stage, top: "sync_fifo", parameters, filelist: ["rtl/sync_fifo.sv"] };
  switch (stage) {
    case "lint":
      return { ...base, files: { ...rtl, "formal/sync_fifo_props.svh": src["formal/sync_fifo_props.svh"] }, options: { include_dirs: ["formal"] } };
    case "simulation":
      return {
        ...base,
        files: { ...rtl, [COCOTB_TEST_PATH]: COCOTB_TEST_SOURCE },
        options: { test_file: COCOTB_TEST_PATH, seed: SIM_SEED, test_env: { FIFO_CONFIG: canonicalJson(cfg) } },
      };
    case "formal":
      return {
        ...base,
        files: { ...rtl, "formal/sync_fifo_props.svh": src["formal/sync_fifo_props.svh"] },
        options: { formal_mode: "prove", formal_depth: 20, formal_engine: "z3_unroll", fallback_engine: "abc_pdr", cover_depth: Math.min(cfg.DEPTH, 16) + 8 },
      };
    case "synthesis":
      return { ...base, files: rtl, options: {} };
    case "physical":
      return {
        ...base,
        files: { ...rtl, ...(src["constraints/approved.sdc"] ? { "constraints/approved.sdc": src["constraints/approved.sdc"] } : {}) },
        options: {
          platform: phys?.platform ?? null,
          clock_period_ns: phys?.clockMhz ? Number((1000 / phys.clockMhz).toFixed(3)) : null,
          constraints_approved: Boolean(phys?.constraintsApproved),
        },
      };
  }
}

/** Same definition as worker hashing.job_input_hash. */
export function jobInputHash(job: Job): string {
  const { schema_version, stage, top, parameters, files, filelist, options } = job;
  return sha256Json({ schema_version, stage, top, parameters, files, filelist, options });
}
