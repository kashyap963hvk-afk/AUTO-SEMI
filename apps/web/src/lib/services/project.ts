import { AgentBlockedError, runAgentTask } from "../ai/agentRuntime";
import { defaultAiPolicy, type ProjectAiPolicy } from "../ai/contracts";
import type { FailureExplainOutput, ReqExtractOutput } from "../ai/prompts";
import { getProfile, getProvider } from "../ai/registry";
import { proposeArchitecture } from "../domain/architecture";
import {
  QUESTION_BY_KEY,
  buildSpec,
  checkApproval,
  emptyFields,
  fieldMap,
  fifoConfig,
  nextQuestion,
  normaliseValue,
  validateValue,
  type FieldKey,
} from "../domain/fifo";
import { RELEASE_POLICIES, buildChecklist, blockers, resultLevel, type ReleaseInputs, type ReleasePolicyId } from "../domain/release";
import { DesignSpec, toYaml, type SpecField } from "../domain/spec";
import { assertTransition, canRunChecks, isRunning, type WorkflowState } from "../domain/workflow";
import { DEMO_DEFECTS, TEMPLATE_ID, generateFilelist, generateProps, generateRtl, generateSdc, resetForms, type DemoDefect } from "../design/fifoTemplate";
import { unifiedDiff } from "../diff";
import { STAGES, type Stage, type StageResult } from "../eda/contracts";
import { buildJob, type SourceFiles } from "../eda/jobs";
import { runStage } from "../eda/runner";
import { newId, sha256, sha256Json } from "../hash";
import * as repo from "../store/repo";
import type { ProjectData, ProjectRow } from "../store/repo";

export class WorkflowError extends Error {
  constructor(message: string, public readonly status = 409) {
    super(message);
    this.name = "WorkflowError";
  }
}

const RTL_STAGES: Stage[] = ["lint", "simulation", "formal", "synthesis"];
const RUNNING_STATE: Record<Stage, WorkflowState> = {
  lint: "RTL_LINTING",
  simulation: "VERIFICATION_RUNNING",
  formal: "FORMAL_RUNNING",
  synthesis: "SYNTHESIS_RUNNING",
  physical: "PHYSICAL_DESIGN_RUNNING",
};

function now(): string {
  return new Date().toISOString();
}

function move(p: ProjectRow, to: WorkflowState): void {
  assertTransition(p.state, to);
  p.state = to;
}

// ---------------------------------------------------------------------------
// Intake & requirements interview
// ---------------------------------------------------------------------------

export function emptyData(): ProjectData {
  return {
    fields: emptyFields(),
    answered: [],
    accepted: [],
    conversation: [],
    extraction: null,
    spec_revision: null,
    spec_approved_revision: null,
    architecture_revision: null,
    architecture_approved_revision: null,
    source_revision: null,
    repair_rounds: 0,
    repair_limit: 3,
    constraints: null,
    release_policy: "rtl-prototype",
    explanations: {},
  };
}

/** Extracted values must quote the user's own words; anything else is dropped as unsupported. */
function checkExtraction(description: string) {
  return (out: ReqExtractOutput) => {
    const warnings: string[] = [];
    const lower = description.toLowerCase();
    const fields = out.fields.filter((f) => {
      if (!f.quote.trim() || !lower.includes(f.quote.toLowerCase().trim())) {
        warnings.push(`dropped ${f.key}="${f.value}": its quote does not appear in the description`);
        return false;
      }
      const err = validateValue(f.key as FieldKey, normaliseValue(f.key as FieldKey, f.value));
      if (err) {
        warnings.push(`dropped ${f.key}="${f.value}": ${err}`);
        return false;
      }
      return true;
    });
    return { output: { ...out, fields }, warnings };
  };
}

export async function createProject(user: { id: string }, input: { name: string; description: string }): Promise<ProjectRow> {
  const name = input.name.trim().slice(0, 80) || "Untitled chip";
  const description = input.description.trim();
  if (description.length < 10 || description.length > 4000) throw new WorkflowError("Describe the chip in 10 to 4000 characters.", 400);
  const project = await repo.insertProject({ id: newId("proj"), owner_id: user.id, name, description, state: "DRAFT", data: emptyData(), ai_policy: defaultAiPolicy() });
  await repo.audit(project.id, user.id, "project.created", { name });
  return analyseDescription(user, project.id);
}

export async function analyseDescription(user: { id: string }, projectId: string): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  p.data.conversation.push({ role: "user", text: p.description, at: now() });
  try {
    const res = await runAgentTask<ReqExtractOutput>({
      ownerId: user.id,
      projectId,
      policy: p.ai_policy,
      role: "requirements_analyst",
      promptId: "req_extract",
      input: { description: p.description },
      check: checkExtraction(p.description),
    });
    const map = fieldMap(p.data.fields);
    for (const f of res.output.fields) {
      const key = f.key as FieldKey;
      map[key] = {
        ...map[key],
        value: normaliseValue(key, f.value),
        source: "ai-proposed",
        status: "proposed",
        confidence: 0.9,
        rationale: `Extracted from your description: "${f.quote}". Please confirm.`,
        revision: map[key].revision + 1,
      };
    }
    p.data.fields = Object.values(map);
    p.data.extraction = { execution_id: res.executionId, provider: res.provider.display_name, mock: res.mock, notes: res.output.notes, warnings: res.warnings, design_kind: res.output.design_kind };
    const found = res.output.fields.map((f) => `${QUESTION_BY_KEY[f.key as FieldKey].label.toLowerCase()} = ${f.value}`);
    const kind =
      res.output.design_kind === "fifo"
        ? "This looks like a FIFO buffer, the design this release supports."
        : "This release supports one design type: a synchronous FIFO buffer. I'll guide you through one. Other block types are not available yet.";
    p.data.conversation.push({
      role: "assistant",
      text: `${kind} ${found.length ? `From your description I picked up: ${found.join(", ")}. These are proposals until you confirm them.` : "I didn't find any specific values, so I'll ask a few short questions."}${res.output.notes.length ? ` Note: ${res.output.notes.join(" ")}` : ""}`,
      at: now(),
      meta: { agent: "requirements_analyst", provider: res.provider.display_name, mock: res.mock, execution_id: res.executionId },
    });
    move(p, "REQUIREMENTS_IN_PROGRESS");
    await repo.audit(projectId, user.id, "requirements.extracted", { execution_id: res.executionId, fields: res.output.fields.map((f) => f.key), mock: res.mock });
  } catch (e) {
    if (!(e instanceof AgentBlockedError)) throw e;
    p.data.conversation.push({ role: "assistant", text: `The configured AI model could not be used (${e.message}). Nothing was sent anywhere else. Choose "Continue without AI extraction" to answer the questions directly, or fix the AI connection in Settings.`, at: now(), meta: { blocked: true, execution_id: e.executionId } });
    move(p, "BLOCKED_AI_PROVIDER");
    await repo.audit(projectId, user.id, "requirements.blocked_ai_provider", { reason: e.message });
  }
  return repo.saveProject(p);
}

export async function skipExtraction(user: { id: string }, projectId: string): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  if (p.state !== "BLOCKED_AI_PROVIDER") throw new WorkflowError("AI extraction is not blocked");
  move(p, "REQUIREMENTS_IN_PROGRESS");
  p.data.conversation.push({ role: "assistant", text: "OK. I'll ask the questions one at a time.", at: now() });
  await repo.audit(projectId, user.id, "requirements.extraction_skipped");
  return repo.saveProject(p);
}

export type AnswerAction = "know" | "confirm" | "suggest" | "unsure";

export async function answerQuestion(user: { id: string }, projectId: string, input: { key: string; action: AnswerAction; value?: unknown }): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  if (!["REQUIREMENTS_IN_PROGRESS", "SPEC_REVIEW_REQUIRED", "SPEC_APPROVED", "ARCHITECTURE_REVIEW_REQUIRED", "RTL_GENERATING", "PROTOTYPE_CHECKS_PASSED", "REPAIR_REQUIRED", "BLOCKED_MISSING_CONSTRAINTS", "BLOCKED_TOOL_UNAVAILABLE", "FAILED", "RELEASE_REVIEW_REQUIRED"].includes(p.state)) {
    throw new WorkflowError(`requirements cannot be edited in state ${p.state}`);
  }
  const q = QUESTION_BY_KEY[input.key as FieldKey];
  if (!q) throw new WorkflowError("unknown question", 400);
  const map = fieldMap(p.data.fields);
  const f = map[q.key];
  let next: SpecField;
  let said: string;
  if (input.action === "know") {
    const value = normaliseValue(q.key, input.value);
    const err = validateValue(q.key, value);
    if (err) throw new WorkflowError(err, 400);
    next = { ...f, value, source: "user-confirmed", status: "confirmed", rationale: "Provided by you.", confidence: 1, revision: f.revision + 1 };
    said = q.kind === "choice" ? q.options!.find((o) => o.value === value)!.label : `${value}${q.unit ? ` ${q.unit}` : ""}`;
  } else if (input.action === "confirm") {
    if (f.status !== "proposed" || f.value === null) throw new WorkflowError("there is no proposal to confirm", 400);
    next = { ...f, source: "user-confirmed", status: "confirmed", rationale: `Confirmed by you (originally: ${f.rationale})`, confidence: 1, revision: f.revision + 1 };
    said = `Yes, ${String(f.value)} is right.`;
  } else if (input.action === "suggest") {
    next = { ...f, value: q.suggestion.value, source: "ai-proposed", status: "proposed", rationale: `Suggested: ${q.suggestion.rationale}`, confidence: 0.6, revision: f.revision + 1 };
    said = "Please suggest one.";
  } else {
    next = { ...f, value: null, source: "tool-derived", status: "unknown", rationale: `Unknown. ${q.ifUnknown}`, confidence: undefined, revision: f.revision + 1 };
    said = "I'm not sure.";
  }
  map[q.key] = next;
  p.data.fields = Object.values(map);
  p.data.accepted = p.data.accepted.filter((k) => k !== q.key);
  if (!p.data.answered.includes(q.key)) p.data.answered.push(q.key);
  p.data.conversation.push({ role: "user", text: said, at: now(), meta: { question: q.key, action: input.action } });
  const reply =
    input.action === "suggest"
      ? `I suggest ${q.kind === "choice" ? q.options!.find((o) => o.value === q.suggestion.value)!.label : `${q.suggestion.value}${q.unit ? ` ${q.unit}` : ""}`}: ${q.suggestion.rationale} This stays a proposal until you accept it at review.`
      : input.action === "unsure"
        ? `No problem. ${q.ifUnknown}`
        : "Got it.";
  p.data.conversation.push({ role: "assistant", text: reply, at: now() });
  // Editing requirements after approval invalidates the approval (a new spec revision is needed).
  if (p.state !== "REQUIREMENTS_IN_PROGRESS") {
    move(p, "REQUIREMENTS_IN_PROGRESS");
    p.data.spec_approved_revision = null;
    p.data.architecture_approved_revision = null;
  }
  await repo.audit(projectId, user.id, "requirements.answered", { key: q.key, action: input.action, source: next.source, status: next.status });
  return repo.saveProject(p);
}

export function interviewState(p: ProjectRow) {
  const q = nextQuestion(p.data.answered);
  const f = q ? fieldMap(p.data.fields)[q.key] : null;
  return { question: q, field: f, done: !q };
}

// ---------------------------------------------------------------------------
// Specification
// ---------------------------------------------------------------------------

export async function generateSpecification(user: { id: string }, projectId: string): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  if (p.state !== "REQUIREMENTS_IN_PROGRESS" && p.state !== "SPEC_REVIEW_REQUIRED") throw new WorkflowError(`cannot generate a specification in state ${p.state}`);
  if (!interviewState(p).done) throw new WorkflowError("answer the remaining questions first (\"Not sure\" is an allowed answer)");
  const revision = (p.data.spec_revision ?? 0) + 1;
  const spec = buildSpec(p.name, revision, p.data.fields, p.data.accepted);
  const parsed = DesignSpec.parse(spec);
  await repo.insertSpecRevision(projectId, revision, parsed, sha256Json(parsed), toYaml(parsed));
  p.data.spec_revision = revision;
  if (p.state === "REQUIREMENTS_IN_PROGRESS") move(p, "SPEC_REVIEW_REQUIRED");
  await repo.audit(projectId, user.id, "spec.generated", { revision, spec_hash: sha256Json(parsed) });
  return repo.saveProject(p);
}

export async function approveSpecification(user: { id: string }, projectId: string, input: { revision: number; accepted: string[]; acknowledge_physical_unknowns: boolean }): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  if (p.state !== "SPEC_REVIEW_REQUIRED") throw new WorkflowError(`nothing to approve in state ${p.state}`);
  if (input.revision !== p.data.spec_revision) throw new WorkflowError("you are approving an outdated specification revision; reload", 409);
  const accepted = input.accepted.filter((k) => k in QUESTION_BY_KEY);
  const check = checkApproval(p.data.fields, accepted);
  if (!check.canApprove) throw new WorkflowError(`cannot approve yet: ${check.blockers.join("; ")}`, 422);
  if (check.physicalUnknowns.length && !input.acknowledge_physical_unknowns) {
    throw new WorkflowError(`please acknowledge that ${check.physicalUnknowns.join(", ")} remain open and will block physical design`, 422);
  }
  // Accepted proposals become confirmed requirements, but keep their AI provenance.
  const at = now();
  p.data.fields = p.data.fields.map((f) =>
    accepted.includes(f.key) && f.status === "proposed" ? { ...f, status: "confirmed" as const, rationale: `${f.rationale} Accepted by ${user.id} at ${at}.`, revision: f.revision + 1 } : f,
  );
  p.data.accepted = accepted;
  const revision = p.data.spec_revision + 1;
  const spec = DesignSpec.parse(buildSpec(p.name, revision, p.data.fields, accepted));
  const approval = { approved_by: user.id, approved_at: at, accepted, physical_unknowns_acknowledged: check.physicalUnknowns };
  await repo.insertSpecRevision(projectId, revision, spec, sha256Json(spec), toYaml({ ...spec, approvals: [approval] }), approval);
  p.data.spec_revision = revision;
  p.data.spec_approved_revision = revision;
  move(p, "SPEC_APPROVED");
  await repo.audit(projectId, user.id, "spec.approved", { revision, accepted, physical_unknowns: check.physicalUnknowns });
  return repo.saveProject(p);
}

// ---------------------------------------------------------------------------
// Architecture
// ---------------------------------------------------------------------------

export async function generateArchitecture(user: { id: string }, projectId: string): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  if (p.state !== "SPEC_APPROVED") throw new WorkflowError("approve the specification first");
  const specRow = await repo.getSpecRevision(projectId, p.data.spec_approved_revision!);
  const arch = proposeArchitecture(specRow!.spec as DesignSpec, specRow!.revision, TEMPLATE_ID);
  const revision = (p.data.architecture_revision ?? 0) + 1;
  await repo.insertArchitecture(projectId, revision, specRow!.revision, arch, sha256Json(arch));
  p.data.architecture_revision = revision;
  move(p, "ARCHITECTURE_REVIEW_REQUIRED");
  await repo.audit(projectId, user.id, "architecture.generated", { revision, spec_revision: specRow!.revision });
  return repo.saveProject(p);
}

export async function approveArchitecture(user: { id: string }, projectId: string, input: { revision: number }): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  if (p.state !== "ARCHITECTURE_REVIEW_REQUIRED") throw new WorkflowError("no architecture is waiting for approval");
  if (input.revision !== p.data.architecture_revision) throw new WorkflowError("outdated architecture revision; reload");
  await repo.approveArchitectureRow(projectId, input.revision, { approved_by: user.id, approved_at: now() });
  p.data.architecture_approved_revision = input.revision;
  move(p, "RTL_GENERATING");
  await repo.audit(projectId, user.id, "architecture.approved", { revision: input.revision });
  return repo.saveProject(p);
}

// ---------------------------------------------------------------------------
// RTL revisions
// ---------------------------------------------------------------------------

async function approvedSpec(p: ProjectRow): Promise<DesignSpec> {
  if (!p.data.spec_approved_revision || !p.data.architecture_approved_revision) throw new WorkflowError("specification and architecture must be approved first");
  const row = await repo.getSpecRevision(p.id, p.data.spec_approved_revision);
  return row!.spec as DesignSpec;
}

function templateFiles(spec: DesignSpec, defects: DemoDefect[]): SourceFiles {
  const cfg = fifoConfig(spec.fields);
  const files: SourceFiles = {
    "rtl/sync_fifo.sv": generateRtl(cfg, defects),
    "formal/sync_fifo_props.svh": generateProps(cfg),
    "rtl/filelist.f": generateFilelist(),
  };
  const clock = fieldMap(spec.fields).clock_mhz;
  if (clock?.value && clock.status === "confirmed") files["constraints/approved.sdc"] = generateSdc(Number(clock.value), resetForms(cfg.RESET).port);
  return files;
}

async function storeRevision(p: ProjectRow, files: SourceFiles, origin: string, provenance: Record<string, unknown>): Promise<number> {
  const revision = (p.data.source_revision ?? 0) + 1;
  const fileHashes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(v as string)]));
  await repo.insertSourceRevision(p.id, {
    revision,
    parent_revision: p.data.source_revision,
    spec_revision: p.data.spec_approved_revision!,
    origin,
    files: files as unknown as Record<string, string>,
    file_hashes: fileHashes,
    manifest_hash: sha256Json(fileHashes),
    provenance,
  });
  p.data.source_revision = revision;
  return revision;
}

export async function generateRtlRevision(user: { id: string }, projectId: string, input: { inject_defect?: DemoDefect | null }): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  if (!["RTL_GENERATING", "PROTOTYPE_CHECKS_PASSED", "REPAIR_REQUIRED", "FAILED", "BLOCKED_TOOL_UNAVAILABLE", "BLOCKED_MISSING_CONSTRAINTS", "RELEASE_REVIEW_REQUIRED", "RELEASE_APPROVED", "PACKAGE_EXPORTED"].includes(p.state)) {
    throw new WorkflowError(`cannot generate RTL in state ${p.state}`);
  }
  const spec = await approvedSpec(p);
  const defects = input.inject_defect ? [input.inject_defect] : [];
  if (defects.some((d) => !(d in DEMO_DEFECTS))) throw new WorkflowError("unknown demo defect", 400);
  const revision = await storeRevision(p, templateFiles(spec, defects), defects.length ? "template+demo-defect" : "template", {
    generator: TEMPLATE_ID,
    generator_kind: "deterministic template (no language model)",
    spec_revision: p.data.spec_approved_revision,
    demo_defects: defects,
  });
  p.data.repair_rounds = 0;
  if (p.state !== "RTL_GENERATING") move(p, "RTL_GENERATING");
  await repo.audit(projectId, user.id, defects.length ? "rtl.generated_with_demo_defect" : "rtl.generated", { revision, defects });
  return repo.saveProject(p);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface LatestRun {
  id: string;
  result: StageResult;
  source_revision: number;
}

export async function latestRuns(projectId: string): Promise<Partial<Record<Stage, LatestRun>>> {
  const runs = await repo.listRuns(projectId);
  const out: Partial<Record<Stage, LatestRun>> = {};
  for (const r of runs) {
    const s = r.stage as Stage;
    if (!out[s]) out[s] = { id: r.id, result: r.result, source_revision: r.source_revision };
  }
  return out;
}

async function physicalContext(p: ProjectRow, files: SourceFiles) {
  const m = fieldMap(p.data.fields);
  const sdcHash = files["constraints/approved.sdc"] ? sha256(files["constraints/approved.sdc"]) : null;
  return {
    clockMhz: m.clock_mhz.status === "confirmed" && m.clock_mhz.value ? Number(m.clock_mhz.value) : null,
    constraintsApproved: Boolean(p.data.constraints && sdcHash && p.data.constraints.sdc_sha256 === sdcHash),
    platform: m.target_pdk.status === "confirmed" && m.target_pdk.value !== "undecided" ? String(m.target_pdk.value) : null,
  };
}

export type RunEvent =
  | { type: "stage_started"; stage: Stage }
  | { type: "stage_finished"; stage: Stage; run_id: string; status: string; summary: string; mode: string }
  | { type: "stopped"; reason: string; state: WorkflowState }
  | { type: "done"; state: WorkflowState };

/**
 * Runs the RTL check sequence (lint -> simulation -> formal -> synthesis) on the current
 * revision, or only `only` when given. A stage runs only if every earlier stage passed on
 * this same revision. The sequence stops at the first stage that does not pass.
 */
export async function runChecks(user: { id: string }, projectId: string, opts: { only?: Stage; onEvent?: (e: RunEvent) => void } = {}): Promise<ProjectRow> {
  let p = await repo.getProject(user.id, projectId);
  const emit = opts.onEvent ?? (() => {});
  if (!p.data.source_revision) throw new WorkflowError("generate RTL first");
  if (isRunning(p.state) && Date.now() - Date.parse(p.updated_at) < 6 * 60_000) throw new WorkflowError("checks are already running for this project");
  if (!canRunChecks(p.state)) throw new WorkflowError(`checks cannot start in state ${p.state}`);
  const src = await repo.getSourceRevision(projectId, p.data.source_revision);
  const files = src!.files as unknown as SourceFiles;
  const spec = await approvedSpec(p);
  const cfg = fifoConfig(spec.fields);
  const latest = await latestRuns(projectId);

  const sequence: Stage[] = opts.only ? [opts.only] : RTL_STAGES;
  if (opts.only && opts.only !== "physical") {
    for (const s of RTL_STAGES.slice(0, RTL_STAGES.indexOf(opts.only))) {
      const r = latest[s];
      if (!r || r.source_revision !== src!.revision || r.result.status !== "PASS") throw new WorkflowError(`${s} must pass on revision ${src!.revision} before ${opts.only} can run`);
    }
  }
  if (opts.only === "physical") {
    for (const s of RTL_STAGES) {
      const r = latest[s];
      if (!r || r.source_revision !== src!.revision || r.result.status !== "PASS") throw new WorkflowError(`all RTL checks must pass on revision ${src!.revision} before physical design`);
    }
  }
  const phys = await physicalContext(p, files);

  for (const stage of sequence) {
    move(p, RUNNING_STATE[stage]);
    p = await repo.saveProject(p);
    emit({ type: "stage_started", stage });
    const job = buildJob(stage, newId("job"), files, cfg, phys);
    const result = await runStage(job);
    const runId = await repo.insertRun(projectId, src!.revision, result);
    await repo.audit(projectId, user.id, "run.finished", { stage, run_id: runId, status: result.status, input_hash: result.input_hash, mode: result.execution.mode, source_revision: src!.revision });
    emit({ type: "stage_finished", stage, run_id: runId, status: result.status, summary: result.summary, mode: result.execution.mode });
    if (result.status !== "PASS") {
      const to: WorkflowState = result.status.startsWith("BLOCKED_") ? (result.status as WorkflowState) : stage === "physical" ? "FAILED" : "REPAIR_REQUIRED";
      move(p, to);
      p = await repo.saveProject(p);
      emit({ type: "stopped", reason: `${stage}: ${result.status}`, state: p.state });
      return p;
    }
  }
  const last = sequence[sequence.length - 1];
  if (last === "synthesis" || last === "physical") {
    move(p, "PROTOTYPE_CHECKS_PASSED");
    p = await repo.saveProject(p);
  }
  emit({ type: "done", state: p.state });
  return p;
}

// ---------------------------------------------------------------------------
// Diagnosis & bounded repair
// ---------------------------------------------------------------------------

export async function explainRun(user: { id: string }, projectId: string, runId: string) {
  const p = await repo.getProject(user.id, projectId);
  const run = await repo.getRun(projectId, runId);
  const r = run.result;
  const input = {
    stage: r.stage,
    status: r.status,
    summary: r.summary,
    findings: r.findings.slice(0, 12).map((f) => ({ code: f.code, message: f.message.slice(0, 300) })),
    failing_tests: r.tests.filter((t) => t.status !== "PASS").map((t) => ({ name: t.name, message: t.message?.slice(0, 300) ?? null, covers: t.covers })),
    failing_properties: r.properties.filter((x) => x.status === "FAIL").map((x) => ({ location: x.location, covers: x.covers, step: x.step ?? null })),
    log_tail: (r.steps.at(-1)?.stdout ?? "").slice(-3000),
  };
  try {
    const res = await runAgentTask<FailureExplainOutput>({ ownerId: user.id, projectId, policy: p.ai_policy, role: "failure_analyst", promptId: "failure_explain", input });
    p.data.explanations[runId] = { execution_id: res.executionId, output: res.output, provider: res.provider.display_name, mock: res.mock, at: now() };
    await repo.audit(projectId, user.id, "run.explained", { run_id: runId, execution_id: res.executionId, mock: res.mock });
    await repo.saveProject(p);
    return { ...res.output, provider: res.provider.display_name, mock: res.mock, execution_id: res.executionId };
  } catch (e) {
    if (e instanceof AgentBlockedError) throw new WorkflowError(e.message, 503);
    throw e;
  }
}

export async function proposeRepair(user: { id: string }, projectId: string) {
  const p = await repo.getProject(user.id, projectId);
  if (p.state !== "REPAIR_REQUIRED") throw new WorkflowError("there is no failed check to repair");
  if (p.data.repair_rounds >= p.data.repair_limit) {
    return { available: false as const, reason: `Repair limit reached (${p.data.repair_limit} rounds). A human decision is needed: review the evidence, the requirements and the tests.` };
  }
  const spec = await approvedSpec(p);
  const current = (await repo.getSourceRevision(projectId, p.data.source_revision!))!.files as unknown as SourceFiles;
  const proposed = templateFiles(spec, []);
  const changed = (Object.keys(proposed) as (keyof SourceFiles)[]).filter((k) => proposed[k] !== current[k]);
  if (!changed.length) {
    return { available: false as const, reason: "The RTL already matches the approved template, so there is no automatic minimal fix. The failure needs a human: check the requirement, the test, or the tool environment. Tests will not be weakened to get a pass." };
  }
  const diff = changed.map((k) => unifiedDiff(current[k] ?? "", proposed[k] ?? "", `a/${k} (rev ${p.data.source_revision})`, `b/${k} (proposed)`)).join("\n");
  return {
    available: true as const,
    proposal_hash: sha256Json(proposed),
    files_changed: changed,
    diff,
    rationale: "Regenerate the affected lines from the approved deterministic template. Tests, assertions and requirements are unchanged.",
    round: p.data.repair_rounds + 1,
    limit: p.data.repair_limit,
  };
}

export async function applyRepair(user: { id: string }, projectId: string, input: { proposal_hash: string }): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  const proposal = await proposeRepair(user, projectId);
  if (!proposal.available) throw new WorkflowError(proposal.reason);
  if (proposal.proposal_hash !== input.proposal_hash) throw new WorkflowError("the repair proposal changed; review it again", 409);
  const spec = await approvedSpec(p);
  const revision = await storeRevision(p, templateFiles(spec, []), "repair", {
    generator: TEMPLATE_ID,
    repair_round: p.data.repair_rounds + 1,
    parent_revision: p.data.source_revision,
    approved_by: user.id,
  });
  p.data.repair_rounds += 1;
  move(p, "RTL_GENERATING");
  await repo.audit(projectId, user.id, "rtl.repair_applied", { revision, round: p.data.repair_rounds, files: proposal.files_changed });
  return repo.saveProject(p);
}

// ---------------------------------------------------------------------------
// Constraints, AI policy
// ---------------------------------------------------------------------------

export async function approveConstraints(user: { id: string }, projectId: string, input: { sdc_sha256: string; approver_name: string }): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  if (!p.data.source_revision) throw new WorkflowError("generate RTL first");
  const files = (await repo.getSourceRevision(projectId, p.data.source_revision))!.files as unknown as SourceFiles;
  const sdc = files["constraints/approved.sdc"];
  if (!sdc) throw new WorkflowError("there is no SDC draft: the clock frequency is not confirmed (TIMING_CONSTRAINTS_INCOMPLETE)", 422);
  if (sha256(sdc) !== input.sdc_sha256) throw new WorkflowError("the SDC changed since you reviewed it; reload", 409);
  if (!input.approver_name.trim()) throw new WorkflowError("approver name is required", 400);
  p.data.constraints = { sdc_sha256: input.sdc_sha256, approved_by: input.approver_name.trim().slice(0, 80), approved_at: now() };
  await repo.audit(projectId, user.id, "constraints.approved", { sdc_sha256: input.sdc_sha256, approver: p.data.constraints.approved_by });
  return repo.saveProject(p);
}

export async function setAiPolicy(user: { id: string }, projectId: string, policy: ProjectAiPolicy): Promise<ProjectRow> {
  const p = await repo.getProject(user.id, projectId);
  for (const id of [policy.default_model_profile, ...Object.values(policy.agent_routing), policy.fallback_model_profile].filter(Boolean) as string[]) {
    if (!(await getProfile(user.id, id))) throw new WorkflowError(`unknown model profile ${id}`, 400);
  }
  for (const id of policy.approved_provider_ids) if (!(await getProvider(user.id, id))) throw new WorkflowError(`unknown provider ${id}`, 400);
  const before = p.ai_policy;
  p.ai_policy = { ...policy, remote_authorized_at: policy.data_egress === "user_authorized_remote" ? (policy.remote_authorized_at ?? now()) : null };
  await repo.audit(projectId, user.id, "ai_policy.changed", { before, after: p.ai_policy });
  return repo.saveProject(p);
}

export async function setReleasePolicy(user: { id: string }, projectId: string, policy: ReleasePolicyId): Promise<ProjectRow> {
  if (!(policy in RELEASE_POLICIES)) throw new WorkflowError("unknown release policy", 400);
  const p = await repo.getProject(user.id, projectId);
  p.data.release_policy = policy;
  await repo.audit(projectId, user.id, "release_policy.changed", { policy });
  return repo.saveProject(p);
}

// ---------------------------------------------------------------------------
// Overview used by the UI and reports
// ---------------------------------------------------------------------------

export async function releaseInputs(p: ProjectRow, humanApproval = false): Promise<ReleaseInputs> {
  const latest = await latestRuns(p.id);
  const m = fieldMap(p.data.fields);
  let constraintsApproved = false;
  if (p.data.source_revision && p.data.constraints) {
    const files = (await repo.getSourceRevision(p.id, p.data.source_revision))!.files as unknown as SourceFiles;
    constraintsApproved = Boolean(files["constraints/approved.sdc"] && sha256(files["constraints/approved.sdc"]) === p.data.constraints.sdc_sha256);
  }
  return {
    policy: p.data.release_policy,
    specApproved: Boolean(p.data.spec_approved_revision),
    architectureApproved: Boolean(p.data.architecture_approved_revision),
    sourceRevision: p.data.source_revision,
    latestRuns: latest,
    constraintsApproved,
    clockKnown: m.clock_mhz.status === "confirmed",
    pdkConfirmed: m.target_pdk.status === "confirmed" && m.target_pdk.value !== "undecided",
    humanApproval,
  };
}

export async function overview(user: { id: string }, projectId: string) {
  const p = await repo.getProject(user.id, projectId);
  const releases = await repo.listReleases(projectId);
  const approved = releases.some((r) => (r.status === "approved" || r.status === "exported") && r.source_revision === p.data.source_revision);
  const inputs = await releaseInputs(p, approved);
  return {
    project: p,
    interview: interviewState(p),
    approval: checkApproval(p.data.fields, p.data.accepted),
    level: resultLevel({ ...inputs, releaseApproved: approved }),
    checklist: buildChecklist(inputs),
    latestRuns: inputs.latestRuns,
    stages: STAGES,
  };
}

export { blockers };
