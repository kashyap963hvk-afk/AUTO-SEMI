import type { Stage, StageResult } from "../eda/contracts";

export const RELEASE_POLICIES = {
  "rtl-prototype": {
    label: "RTL prototype (lint, simulation, formal, synthesis)",
    description: "Packages verified, synthesizable RTL for engineering review. Physical implementation is explicitly outside this package and must be done before any tapeout.",
    requiredStages: ["lint", "simulation", "formal", "synthesis"] as Stage[],
    physical: false,
  },
  "open-pdk-physical-prototype": {
    label: "Open-PDK physical prototype (adds RTL→GDS, STA, DRC/LVS)",
    description: "Also requires approved timing constraints and a completed physical flow with timing and layout checks on the selected public PDK.",
    requiredStages: ["lint", "simulation", "formal", "synthesis", "physical"] as Stage[],
    physical: true,
  },
} as const;
export type ReleasePolicyId = keyof typeof RELEASE_POLICIES;

export type ItemStatus = "pass" | "fail" | "missing" | "stale" | "not_applicable" | "waiting";

export interface ChecklistItem {
  id: string;
  title: string;
  requirement: "required" | "optional" | "not_applicable";
  status: ItemStatus;
  detail: string;
}

export interface ReleaseInputs {
  policy: ReleasePolicyId;
  specApproved: boolean;
  architectureApproved: boolean;
  sourceRevision: number | null;
  latestRuns: Partial<Record<Stage, { result: StageResult; source_revision: number }>>;
  constraintsApproved: boolean;
  clockKnown: boolean;
  pdkConfirmed: boolean;
  humanApproval: boolean;
}

function stageItem(stage: Stage, title: string, inp: ReleaseInputs, required: boolean): ChecklistItem {
  const run = inp.latestRuns[stage];
  const requirement = required ? "required" : "optional";
  if (!run) return { id: `run.${stage}`, title, requirement, status: "missing", detail: "not run on any revision" };
  if (run.source_revision !== inp.sourceRevision) return { id: `run.${stage}`, title, requirement, status: "stale", detail: `last run on revision ${run.source_revision}, current revision is ${inp.sourceRevision}` };
  const r = run.result;
  if (r.status === "PASS") {
    const mode = r.execution.mode === "recorded" ? " (recorded real run, matched by input hash)" : r.execution.mode === "live-wasm" ? " (Yosys/WASM in-process)" : "";
    const formal = stage === "formal" && r.formal_status && !r.summary.includes(r.formal_status) ? ` [${r.formal_status}]` : "";
    return { id: `run.${stage}`, title, requirement, status: "pass", detail: `${r.summary}${formal}${mode}` };
  }
  return { id: `run.${stage}`, title, requirement, status: r.status.startsWith("BLOCKED") ? "missing" : "fail", detail: `${r.status}: ${r.summary}` };
}

/** Checks the physical stage could not run: never silently passed; a reviewer must accept each one explicitly. */
function physicalGaps(inp: ReleaseInputs): ChecklistItem[] {
  const run = inp.latestRuns.physical;
  const checks = (run?.result.metrics as { checks?: Record<string, string> } | undefined)?.checks ?? {};
  const gap = (id: string, title: string, key: string, why: string): ChecklistItem => ({
    id,
    title,
    requirement: "optional",
    status: checks[key] === "PASS" ? "pass" : "missing",
    detail: checks[key] === "PASS" ? "run and passed" : `${checks[key] ?? "NOT_RUN"}: ${why}`,
  });
  return [
    gap("phys.feol_drc", "FEOL DRC (diffusion / poly / well rules)", "klayout_drc_feol", "the open deck's FEOL rules did not run or reported violations; required before tapeout"),
    gap("phys.multi_corner", "Multi-corner STA (slow/fast corners)", "multi_corner_sta", "only the typical corner library is installed"),
    gap("phys.equivalence", "Logic equivalence: final netlist vs RTL", "equivalence_check", "eqy is not installed"),
  ];
}

/** A layout run that exists but did not pass is disclosed even where the policy does not require one. */
function physicalNote(inp: ReleaseInputs): string {
  const run = inp.latestRuns.physical;
  if (!run || run.source_revision !== inp.sourceRevision || run.result.status === "PASS" || run.result.status.startsWith("BLOCKED")) return "";
  return ` Note: a physical run on this revision reported ${run.result.status}: ${run.result.summary}`;
}

export function buildChecklist(inp: ReleaseInputs): ChecklistItem[] {
  const pol = RELEASE_POLICIES[inp.policy];
  const items: ChecklistItem[] = [
    { id: "spec.approved", title: "Design specification approved (no unaccepted critical assumptions)", requirement: "required", status: inp.specApproved ? "pass" : "missing", detail: inp.specApproved ? "approved revision on record" : "specification not approved" },
    { id: "arch.approved", title: "Architecture approved", requirement: "required", status: inp.architectureApproved ? "pass" : "missing", detail: inp.architectureApproved ? "approved" : "not approved" },
    { id: "rtl.revision", title: "Immutable RTL revision with SHA-256 manifest", requirement: "required", status: inp.sourceRevision ? "pass" : "missing", detail: inp.sourceRevision ? `revision ${inp.sourceRevision}` : "no RTL generated" },
    stageItem("lint", "Lint & elaboration (Verilator + Yosys)", inp, true),
    stageItem("simulation", "Simulation regression (cocotb)", inp, true),
    stageItem("formal", "Formal verification (SymbiYosys)", inp, true),
    stageItem("synthesis", "Logic synthesis (Yosys) with no latches", inp, true),
  ];
  if (pol.physical) {
    items.push(
      { id: "constraints.sdc", title: "Timing constraints (SDC) approved by a human", requirement: "required", status: inp.constraintsApproved ? "pass" : inp.clockKnown ? "waiting" : "missing", detail: inp.constraintsApproved ? "approved" : inp.clockKnown ? "draft SDC awaiting approval" : "TIMING_CONSTRAINTS_INCOMPLETE: clock frequency unknown" },
      { id: "pdk.confirmed", title: "PDK variant confirmed and collateral available", requirement: "required", status: inp.pdkConfirmed ? "pass" : "missing", detail: inp.pdkConfirmed ? "PDK named in the approved spec" : "PDK not confirmed" },
      stageItem("physical", "Physical implementation (ORFS) with STA, DRC, LVS, antenna", inp, true),
      ...physicalGaps(inp),
    );
  } else {
    items.push(
      { id: "constraints.sdc", title: "Timing constraints (SDC)", requirement: "optional", status: inp.constraintsApproved ? "pass" : "not_applicable", detail: "not required for an RTL-only package; required before physical design" },
      { id: "run.physical", title: "Physical implementation, STA, DRC/LVS", requirement: "not_applicable", status: "not_applicable", detail: `outside this release policy. The package is not layout-ready.${physicalNote(inp)}` },
    );
  }
  items.push(
    { id: "dft", title: "DFT / scan / ATPG", requirement: "not_applicable", status: "not_applicable", detail: "not generated in this release; must be addressed before production tapeout" },
    { id: "io.package", title: "I/O pads, pad ring, packaging", requirement: "not_applicable", status: "not_applicable", detail: "out of scope for a standalone block" },
    { id: "human.signoff", title: "Qualified human sign-off", requirement: "required", status: inp.humanApproval ? "pass" : "waiting", detail: inp.humanApproval ? "signed off" : "awaiting reviewer" },
  );
  return items;
}

/** Blockers ignore the human sign-off, which comes last. */
export function blockers(items: ChecklistItem[], includeSignoff = false): ChecklistItem[] {
  return items.filter((i) => i.requirement === "required" && i.status !== "pass" && (includeSignoff || i.id !== "human.signoff"));
}

/** Result levels (spec section 34). Level 6 is unreachable: there is no provider integration. */
export function resultLevel(inp: Omit<ReleaseInputs, "policy" | "humanApproval"> & { releaseApproved: boolean }): { level: number; label: string } {
  const ok = (s: Stage) => {
    const r = inp.latestRuns[s];
    return r && r.source_revision === inp.sourceRevision && r.result.status === "PASS";
  };
  if (!inp.specApproved || !inp.architectureApproved) return { level: -1, label: "Specification in progress" };
  if (!ok("lint")) return { level: 0, label: "Level 0: specification ready" };
  if (!ok("simulation")) return { level: 1, label: "Level 1: RTL checks passed" };
  if (!ok("synthesis") || !ok("formal")) return { level: 2, label: "Level 2: verification checks passed" };
  if (!ok("physical")) return { level: 3, label: inp.releaseApproved ? "Level 3: synthesized (RTL release candidate reviewed)" : "Level 3: synthesized" };
  return { level: inp.releaseApproved ? 5 : 4, label: inp.releaseApproved ? "Level 5: release candidate reviewed" : "Level 4: physical prototype checks passed" };
}
