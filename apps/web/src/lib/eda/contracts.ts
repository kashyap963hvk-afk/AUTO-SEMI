import { z } from "zod";

/** Mirror of worker/devin_vlsi_worker/models.py. Worker responses are validated against this. */
export const STAGES = ["lint", "simulation", "formal", "synthesis", "physical"] as const;
export type Stage = (typeof STAGES)[number];

export const StageStatus = z.enum([
  "PASS",
  "FAIL",
  "ERROR",
  "TIMEOUT",
  "NOT_RUN",
  "BLOCKED_TOOL_UNAVAILABLE",
  "BLOCKED_MISSING_CONSTRAINTS",
  "BLOCKED_UNSUPPORTED_FEATURE",
]);
export type StageStatus = z.infer<typeof StageStatus>;

export const FormalStatus = z.enum(["PROVED", "COUNTEREXAMPLE_FOUND", "BOUNDED_PASS_ONLY", "UNKNOWN", "TIMEOUT", "NOT_RUN"]);
export type FormalStatus = z.infer<typeof FormalStatus>;

export const ExecutionMode = z.enum(["live-worker", "recorded", "live-wasm", "unavailable"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

const Finding = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  tool: z.string(),
  file: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
});

const Step = z.object({
  tool: z.string(),
  version: z.string().nullable(),
  command: z.array(z.string()),
  exit_code: z.number().nullable(),
  status: StageStatus,
  duration_s: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});

export const StageResult = z.object({
  schema_version: z.literal("1.0"),
  job_id: z.string(),
  stage: z.enum(STAGES),
  status: StageStatus,
  summary: z.string(),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/),
  started_at: z.string(),
  finished_at: z.string(),
  duration_s: z.number(),
  execution: z.object({ mode: ExecutionMode }).passthrough(),
  steps: z.array(Step),
  findings: z.array(Finding),
  tests: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["PASS", "FAIL", "SKIP", "ERROR"]),
      covers: z.array(z.string()),
      duration_s: z.number().nullable().optional(),
      message: z.string().nullable().optional(),
    }),
  ),
  properties: z.array(
    z.object({
      kind: z.enum(["assert", "cover"]),
      location: z.string(),
      status: z.enum(["PASS", "FAIL", "REACHED", "UNREACHED", "UNKNOWN"]),
      covers: z.array(z.string()),
      step: z.number().nullable().optional(),
    }),
  ),
  formal_status: FormalStatus.nullable().optional(),
  metrics: z.record(z.unknown()),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string(), size: z.number(), content: z.string().nullable().optional() })),
  limitations: z.array(z.string()),
});
export type StageResult = z.infer<typeof StageResult>;

export interface Job {
  schema_version: "1.0";
  job_id: string;
  stage: Stage;
  top: string;
  parameters: Record<string, number>;
  files: Record<string, string>;
  filelist: string[];
  options: Record<string, unknown>;
  limits?: { timeout_s: number; memory_mb: number; max_output_bytes: number };
}

export const STAGE_LABEL: Record<Stage, string> = {
  lint: "Lint & elaboration",
  simulation: "Simulation regression",
  formal: "Formal verification",
  synthesis: "Logic synthesis",
  physical: "Physical design (RTL→GDS)",
};

export const STAGE_PLAIN: Record<Stage, string> = {
  lint: "Checks the design source for mistakes a compiler can spot: typos, width mismatches, missing connections.",
  simulation: "Runs the design in a simulator against tests that act like a user and compares every output with a reference model.",
  formal: "Uses a mathematical solver to check rules for every possible input sequence, not just the tests we wrote.",
  synthesis: "Converts the design into logic gates and flip-flops and counts them (an estimate of size).",
  physical: "Places and wires the gates for a real manufacturing technology and checks timing and layout rules.",
};
