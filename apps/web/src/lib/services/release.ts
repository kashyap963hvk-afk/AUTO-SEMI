import { gunzipSync } from "node:zlib";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { COCOTB_TEST_PATH, COCOTB_TEST_SOURCE } from "@/generated/designAssets";
import { RELEASE_POLICIES, blockers, buildChecklist, resultLevel, type ChecklistItem } from "../domain/release";
import { toYaml, type DesignSpec } from "../domain/spec";
import { assertTransition } from "../domain/workflow";
import { STAGES } from "../eda/contracts";
import { canonicalJson, newId, sha256 } from "../hash";
import * as repo from "../store/repo";
import { WorkflowError, latestRuns, releaseInputs } from "./project";
import { engineeringReport, userSummary } from "./reports";

const STATUS_NOTE =
  "PACKAGE CREATED FOR EXPERT REVIEW. This package has NOT been submitted to any foundry, shuttle or MPW provider and has NOT been accepted by one. Open-source and public-PDK checks are prototype checks, not foundry sign-off.";

export async function createReleaseCandidate(user: { id: string }, projectId: string) {
  const p = await repo.getProject(user.id, projectId);
  if (!p.data.source_revision) throw new WorkflowError("generate RTL first");
  const inputs = await releaseInputs(p);
  const checklist = buildChecklist(inputs);
  const blocking = blockers(checklist);
  const id = newId("rc");
  await repo.insertRelease({ id, project_id: projectId, source_revision: p.data.source_revision, policy: p.data.release_policy, checklist, status: blocking.length ? "blocked" : "review_required" });
  await repo.audit(projectId, user.id, blocking.length ? "release.candidate_blocked" : "release.candidate_created", { id, policy: p.data.release_policy, blockers: blocking.map((b) => b.id) });
  if (!blocking.length) {
    assertTransition(p.state, "RELEASE_REVIEW_REQUIRED");
    p.state = "RELEASE_REVIEW_REQUIRED";
    await repo.saveProject(p);
  }
  return { id, checklist, blockers: blocking, status: blocking.length ? "blocked" : "review_required" };
}

export async function approveRelease(user: { id: string }, candidateId: string, input: { approver_name: string; approver_role: string; qualified_reviewer: boolean; accepted_open_issues: string[] }) {
  const rc = await repo.getRelease(user.id, candidateId);
  const p = await repo.getProject(user.id, rc.project_id);
  if (rc.status !== "review_required") throw new WorkflowError(`release candidate is ${rc.status}`);
  if (!input.qualified_reviewer) throw new WorkflowError("sign-off requires confirming you are a qualified human reviewer; the AI cannot sign off", 422);
  if (!input.approver_name.trim() || !input.approver_role.trim()) throw new WorkflowError("approver name and role are required", 400);
  if (rc.source_revision !== p.data.source_revision) throw new WorkflowError("the RTL changed after this candidate was created (stale); create a new candidate", 409);
  // Re-evaluate: nothing may have gone stale or failed since the candidate was created.
  const checklist = buildChecklist({ ...(await releaseInputs(p)), humanApproval: true });
  const blocking = blockers(checklist, true);
  if (blocking.length) throw new WorkflowError(`blocked: ${blocking.map((b) => b.title).join("; ")}`, 422);
  const openIssues = checklist.filter((i) => i.requirement !== "required" && i.status !== "pass").map((i) => i.id);
  const missingAck = openIssues.filter((i) => !input.accepted_open_issues.includes(i));
  if (missingAck.length) throw new WorkflowError(`please explicitly accept the open, non-mandatory items: ${missingAck.join(", ")}`, 422);
  const approval = {
    approver_name: input.approver_name.trim().slice(0, 80),
    approver_role: input.approver_role.trim().slice(0, 80),
    approved_at: new Date().toISOString(),
    accepted_open_issues: openIssues,
    statement: "I reviewed the engineering evidence for this release candidate. This approval does not constitute foundry acceptance.",
  };
  await repo.updateRelease(candidateId, { status: "approved", approval, checklist });
  assertTransition(p.state, "RELEASE_APPROVED");
  p.state = "RELEASE_APPROVED";
  await repo.saveProject(p);
  await repo.audit(p.id, user.id, "release.approved", { candidate: candidateId, approver: approval.approver_name, role: approval.approver_role, source_revision: rc.source_revision });
  return { ok: true };
}

/** Deterministic package: identical inputs and approval produce byte-identical manifest and archive. */
export async function exportRelease(user: { id: string }, candidateId: string): Promise<{ zip: Uint8Array; filename: string; manifest_sha256: string }> {
  const rc = await repo.getRelease(user.id, candidateId);
  const p = await repo.getProject(user.id, rc.project_id);
  if (rc.status !== "approved" && rc.status !== "exported") throw new WorkflowError("export requires an approved release candidate", 422);
  if (rc.source_revision !== p.data.source_revision) throw new WorkflowError("stale candidate: the RTL changed after approval", 409);
  const inputs = await releaseInputs(p, true);
  const checklist = buildChecklist(inputs);
  const blocking = blockers(checklist, true);
  if (blocking.length) throw new WorkflowError(`refusing to export: ${blocking.map((b) => b.title).join("; ")}`, 422);

  const src = (await repo.getSourceRevision(p.id, rc.source_revision))!;
  const specRow = (await repo.getSpecRevision(p.id, p.data.spec_approved_revision!))!;
  const spec = specRow.spec as DesignSpec;
  const arch = await repo.getArchitecture(p.id, p.data.architecture_approved_revision!);
  const latest = await latestRuns(p.id);
  const level = resultLevel({ ...inputs, releaseApproved: true });
  const files: Record<string, string | Uint8Array> = {};
  for (const [k, v] of Object.entries(src.files)) files[k] = v;
  files[COCOTB_TEST_PATH] = COCOTB_TEST_SOURCE;
  files["spec/design_spec.yaml"] = specRow.yaml;
  files["spec/design_spec.json"] = JSON.stringify(spec, null, 2) + "\n";
  files["architecture/architecture.json"] = JSON.stringify(arch!.content, null, 2) + "\n";
  for (const s of STAGES) {
    const run = latest[s];
    if (!run || run.source_revision !== rc.source_revision) continue;
    files[`evidence/${s}/result.json`] = JSON.stringify(run.result, null, 2) + "\n";
    for (const a of run.result.artifacts) {
      if (a.content == null || !/^[A-Za-z0-9_./-]+$/.test(a.path) || a.path.includes("..")) continue;
      const name = a.path.split("/").pop()!;
      const dest = s === "physical" && name.endsWith(".gds") ? `physical/${name}` : `evidence/${s}/${a.path}`;
      const bytes = a.encoding === "gzip+base64" ? new Uint8Array(gunzipSync(Buffer.from(a.content, "base64"))) : a.content;
      if (typeof bytes !== "string" && sha256(bytes) !== a.sha256) throw new WorkflowError(`artifact ${a.path} does not match its recorded SHA-256`, 500);
      files[dest] = bytes;
    }
  }
  const policy = RELEASE_POLICIES[rc.policy];
  files["reports/user_summary.md"] = userSummary({ name: p.name, spec, level, latest, revision: rc.source_revision, checklist, policyLabel: policy.label });
  files["reports/engineering_report.md"] = engineeringReport({ name: p.name, spec, specRevision: specRow.revision, specHash: specRow.spec_hash, source: src, latest, checklist, level });
  files["release/release_checklist.yaml"] = toYaml({ policy: rc.policy, items: checklist }) + "\n";
  files["README_FIRST.txt"] = `${p.name}\n\n${STATUS_NOTE}\n\nResult level: ${level.label}\nRelease policy: ${policy.label}\n${policy.description}\n\nVerify integrity: sha256sum -c release/sha256sums.txt\n`;

  const size = (v: string | Uint8Array) => (typeof v === "string" ? Buffer.byteLength(v) : v.length);
  const fileList = Object.keys(files).sort().map((path) => ({ path, sha256: sha256(files[path]), size: size(files[path]) }));
  const manifest = {
    schema_version: "1.0",
    status: STATUS_NOTE,
    project: { id: p.id, name: p.name },
    release_candidate: rc.id,
    policy: rc.policy,
    result_level: level,
    specification: { revision: specRow.revision, sha256: specRow.spec_hash },
    source: { revision: src.revision, origin: src.origin, manifest_sha256: src.manifest_hash },
    approval: rc.approval,
    runs: STAGES.flatMap((s) => {
      const r = latest[s];
      return r && r.source_revision === rc.source_revision
        ? [{ stage: s, run_id: r.id, status: r.result.status, formal_status: r.result.formal_status ?? null, input_hash: r.result.input_hash, execution_mode: r.result.execution.mode, tool_versions: (r.result.execution as { tool_versions?: unknown }).tool_versions ?? null }]
        : [];
    }),
    files: fileList,
  };
  files["release/manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";
  const all = Object.keys(files).sort();
  files["release/sha256sums.txt"] = all.map((f) => `${sha256(files[f])}  ${f}`).join("\n") + "\n";

  const mtime = new Date("2026-01-01T00:00:00Z");
  const tree: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const f of Object.keys(files).sort()) {
    const v = files[f];
    tree[f] = [typeof v === "string" ? strToU8(v) : v, { mtime }];
  }
  const zip = zipSync(tree, { level: 6 });
  const manifestSha = sha256(files["release/manifest.json"] as string);
  await repo.updateRelease(candidateId, { status: "exported", manifest, manifest_hash: manifestSha });
  if (p.state !== "PACKAGE_EXPORTED") {
    assertTransition(p.state, "PACKAGE_EXPORTED");
    p.state = "PACKAGE_EXPORTED";
    await repo.saveProject(p);
  }
  await repo.audit(p.id, user.id, "release.exported", { candidate: candidateId, manifest_sha256: manifestSha, files: all.length });
  return { zip, filename: `${p.name.replace(/[^A-Za-z0-9_-]+/g, "_")}_rev${src.revision}_release_candidate.zip`, manifest_sha256: manifestSha };
}

export interface VerifyReport {
  ok: boolean;
  checked: number;
  problems: string[];
}

/** Recompute every checksum in a package; any edited, added or removed file is reported. */
export function verifyPackage(zip: Uint8Array): VerifyReport {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    return { ok: false, checked: 0, problems: ["not a readable ZIP archive"] };
  }
  const problems: string[] = [];
  for (const name of Object.keys(entries)) if (name.startsWith("/") || name.includes("..")) problems.push(`unsafe path in archive: ${name}`);
  const sums = entries["release/sha256sums.txt"];
  if (!sums) return { ok: false, checked: 0, problems: [...problems, "release/sha256sums.txt is missing"] };
  const listed = new Map<string, string>();
  for (const line of strFromU8(sums).split("\n").filter(Boolean)) {
    const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!m) problems.push(`malformed checksum line: ${line.slice(0, 80)}`);
    else listed.set(m[2], m[1]);
  }
  for (const [path, hash] of listed) {
    const data = entries[path];
    if (!data) problems.push(`missing file: ${path}`);
    else if (sha256(data) !== hash) problems.push(`checksum mismatch: ${path}`);
  }
  for (const path of Object.keys(entries)) if (path !== "release/sha256sums.txt" && !listed.has(path) && !path.endsWith("/")) problems.push(`unlisted file: ${path}`);
  try {
    const manifest = JSON.parse(strFromU8(entries["release/manifest.json"])) as { files: { path: string; sha256: string }[] };
    for (const f of manifest.files) if (listed.get(f.path) !== f.sha256) problems.push(`manifest disagrees with sha256sums for ${f.path}`);
  } catch {
    problems.push("release/manifest.json is missing or invalid");
  }
  return { ok: problems.length === 0, checked: listed.size, problems };
}

export function checklistSummary(items: ChecklistItem[]) {
  return canonicalJson(items.map((i) => [i.id, i.status]));
}
