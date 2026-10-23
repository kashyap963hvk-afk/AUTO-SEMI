import { getDb } from "./db";
import { newId, sha256 } from "../hash";
import type { WorkflowState } from "../domain/workflow";
import type { SpecField } from "../domain/spec";
import type { ProjectAiPolicy } from "../ai/contracts";
import type { ReleasePolicyId } from "../domain/release";
import type { StageResult } from "../eda/contracts";

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
  meta?: Record<string, unknown>;
}

export interface ProjectData {
  fields: SpecField[];
  answered: string[];
  accepted: string[];
  conversation: ConversationTurn[];
  extraction: { execution_id: string; provider: string; mock: boolean; notes: string[]; warnings: string[]; design_kind: string } | null;
  spec_revision: number | null;
  spec_approved_revision: number | null;
  architecture_revision: number | null;
  architecture_approved_revision: number | null;
  source_revision: number | null;
  repair_rounds: number;
  repair_limit: number;
  constraints: { sdc_sha256: string; approved_by: string; approved_at: string } | null;
  release_policy: ReleasePolicyId;
  explanations: Record<string, { execution_id: string; output: unknown; provider: string; mock: boolean; at: string }>;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  state: WorkflowState;
  data: ProjectData;
  ai_policy: ProjectAiPolicy;
  version: number;
  created_at: string;
  updated_at: string;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function toProject(r: Record<string, unknown>): ProjectRow {
  return { ...(r as unknown as ProjectRow), created_at: iso(r.created_at), updated_at: iso(r.updated_at) };
}

// ---- users / sessions -------------------------------------------------------

export async function userByToken(token: string): Promise<{ id: string; display_name: string } | null> {
  const db = await getDb();
  const rows = await db.query<{ id: string; display_name: string }>("SELECT id, display_name FROM users WHERE token_hash = $1", [sha256(token)]);
  return rows[0] ?? null;
}

export async function createUser(token: string): Promise<{ id: string; display_name: string }> {
  const db = await getDb();
  const id = newId("user");
  const display_name = `Guest ${id.slice(-4)}`;
  await db.query("INSERT INTO users (id, token_hash, display_name) VALUES ($1, $2, $3)", [id, sha256(token), display_name]);
  return { id, display_name };
}

// ---- projects ---------------------------------------------------------------

export async function insertProject(p: Omit<ProjectRow, "version" | "created_at" | "updated_at">): Promise<ProjectRow> {
  const db = await getDb();
  await db.query("INSERT INTO projects (id, owner_id, name, description, state, data, ai_policy) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)", [
    p.id, p.owner_id, p.name, p.description, p.state, p.data, p.ai_policy,
  ]);
  return getProject(p.owner_id, p.id);
}

/** Owner-scoped read: another user's project is indistinguishable from a missing one. */
export async function getProject(ownerId: string, id: string): Promise<ProjectRow> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM projects WHERE id = $1 AND owner_id = $2", [id, ownerId]);
  if (!rows[0]) throw new NotFoundError("project");
  return toProject(rows[0]);
}

export async function listProjects(ownerId: string): Promise<ProjectRow[]> {
  const db = await getDb();
  return (await db.query("SELECT * FROM projects WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 100", [ownerId])).map(toProject);
}

/** Optimistic-concurrency update: fails if someone else changed the project meanwhile. */
export async function saveProject(p: ProjectRow): Promise<ProjectRow> {
  const db = await getDb();
  const rows = await db.query(
    "UPDATE projects SET state = $1, data = $2::jsonb, ai_policy = $3::jsonb, version = version + 1, updated_at = now() WHERE id = $4 AND owner_id = $5 AND version = $6 RETURNING *",
    [p.state, p.data, p.ai_policy, p.id, p.owner_id, p.version],
  );
  if (!rows[0]) throw new ConflictError("the project was changed by another request; reload and try again");
  return toProject(rows[0]);
}

// ---- audit ------------------------------------------------------------------

export async function audit(projectId: string | null, actor: string, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  const db = await getDb();
  await db.query("INSERT INTO audit_events (id, project_id, actor, action, detail) VALUES ($1,$2,$3,$4,$5::jsonb)", [newId("evt"), projectId, actor, action, detail]);
}

export async function listAudit(projectId: string) {
  const db = await getDb();
  return (await db.query<{ id: string; actor: string; action: string; detail: Record<string, unknown>; created_at: unknown }>(
    "SELECT id, actor, action, detail, created_at FROM audit_events WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200",
    [projectId],
  )).map((r) => ({ ...r, created_at: iso(r.created_at) }));
}

// ---- immutable revisions ----------------------------------------------------

export interface SpecRevisionRow {
  id: string;
  revision: number;
  spec: unknown;
  spec_hash: string;
  yaml: string;
  approval: { approved_by: string; approved_at: string; accepted: string[]; physical_unknowns_acknowledged: string[] } | null;
  created_at: string;
}

export async function insertSpecRevision(projectId: string, revision: number, spec: unknown, specHash: string, yaml: string, approval: SpecRevisionRow["approval"] = null) {
  const db = await getDb();
  await db.query("INSERT INTO spec_revisions (id, project_id, revision, spec, spec_hash, yaml, approval) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)", [
    newId("spec"), projectId, revision, spec, specHash, yaml, approval,
  ]);
}

export async function getSpecRevision(projectId: string, revision: number): Promise<SpecRevisionRow | null> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM spec_revisions WHERE project_id = $1 AND revision = $2", [projectId, revision]);
  return rows[0] ? ({ ...(rows[0] as unknown as SpecRevisionRow), created_at: iso(rows[0].created_at) }) : null;
}

export async function listSpecRevisions(projectId: string) {
  const db = await getDb();
  return db.query<{ revision: number; spec_hash: string; approval: unknown; created_at: unknown }>("SELECT revision, spec_hash, approval, created_at FROM spec_revisions WHERE project_id = $1 ORDER BY revision", [projectId]);
}

export async function insertArchitecture(projectId: string, revision: number, specRevision: number, content: unknown, hash: string) {
  const db = await getDb();
  await db.query("INSERT INTO architecture_revisions (id, project_id, revision, spec_revision, content, content_hash) VALUES ($1,$2,$3,$4,$5::jsonb,$6)", [
    newId("arch"), projectId, revision, specRevision, content, hash,
  ]);
}

export async function approveArchitectureRow(projectId: string, revision: number, approval: unknown) {
  const db = await getDb();
  const rows = await db.query("UPDATE architecture_revisions SET approval = $1::jsonb WHERE project_id = $2 AND revision = $3 AND approval IS NULL RETURNING id", [approval, projectId, revision]);
  if (!rows[0]) throw new ConflictError("architecture revision not found or already approved");
}

export async function getArchitecture(projectId: string, revision: number) {
  const db = await getDb();
  const rows = await db.query<{ revision: number; spec_revision: number; content: unknown; content_hash: string; approval: unknown }>(
    "SELECT revision, spec_revision, content, content_hash, approval FROM architecture_revisions WHERE project_id = $1 AND revision = $2",
    [projectId, revision],
  );
  return rows[0] ?? null;
}

export interface SourceRevisionRow {
  revision: number;
  parent_revision: number | null;
  spec_revision: number;
  origin: string;
  files: Record<string, string>;
  file_hashes: Record<string, string>;
  manifest_hash: string;
  provenance: Record<string, unknown>;
  created_at: string;
}

export async function insertSourceRevision(projectId: string, row: Omit<SourceRevisionRow, "created_at">) {
  const db = await getDb();
  await db.query(
    "INSERT INTO source_revisions (id, project_id, revision, parent_revision, spec_revision, origin, files, file_hashes, manifest_hash, provenance) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb)",
    [newId("src"), projectId, row.revision, row.parent_revision, row.spec_revision, row.origin, row.files, row.file_hashes, row.manifest_hash, row.provenance],
  );
}

export async function getSourceRevision(projectId: string, revision: number): Promise<SourceRevisionRow | null> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM source_revisions WHERE project_id = $1 AND revision = $2", [projectId, revision]);
  return rows[0] ? ({ ...(rows[0] as unknown as SourceRevisionRow), created_at: iso(rows[0].created_at) }) : null;
}

export async function listSourceRevisions(projectId: string) {
  const db = await getDb();
  return (await db.query<{ revision: number; parent_revision: number | null; origin: string; manifest_hash: string; created_at: unknown }>(
    "SELECT revision, parent_revision, origin, manifest_hash, created_at FROM source_revisions WHERE project_id = $1 ORDER BY revision",
    [projectId],
  )).map((r) => ({ ...r, created_at: iso(r.created_at) }));
}

// ---- runs -------------------------------------------------------------------

export interface RunRow {
  id: string;
  source_revision: number;
  stage: string;
  status: string;
  input_hash: string;
  execution_mode: string;
  result: StageResult;
  created_at: string;
}

export async function insertRun(projectId: string, sourceRevision: number, result: StageResult): Promise<string> {
  const db = await getDb();
  const id = newId("run");
  await db.query("INSERT INTO runs (id, project_id, source_revision, stage, status, input_hash, execution_mode, result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [
    id, projectId, sourceRevision, result.stage, result.status, result.input_hash, result.execution.mode, result,
  ]);
  return id;
}

export async function listRuns(projectId: string): Promise<RunRow[]> {
  const db = await getDb();
  return (await db.query("SELECT * FROM runs WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200", [projectId])).map(
    (r) => ({ ...(r as unknown as RunRow), created_at: iso(r.created_at) }),
  );
}

export async function getRun(projectId: string, runId: string): Promise<RunRow> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM runs WHERE project_id = $1 AND id = $2", [projectId, runId]);
  if (!rows[0]) throw new NotFoundError("run");
  return { ...(rows[0] as unknown as RunRow), created_at: iso(rows[0].created_at) };
}

// ---- release candidates -----------------------------------------------------

export interface ReleaseRow {
  id: string;
  project_id: string;
  source_revision: number;
  policy: ReleasePolicyId;
  checklist: unknown;
  manifest: unknown;
  manifest_hash: string | null;
  status: string;
  approval: { approver_name: string; approver_role: string; approved_at: string; accepted_open_issues: string[]; statement: string } | null;
  created_at: string;
}

export async function insertRelease(row: Omit<ReleaseRow, "created_at" | "manifest" | "manifest_hash" | "approval">): Promise<void> {
  const db = await getDb();
  await db.query("INSERT INTO release_candidates (id, project_id, source_revision, policy, checklist, status) VALUES ($1,$2,$3,$4,$5::jsonb,$6)", [
    row.id, row.project_id, row.source_revision, row.policy, row.checklist, row.status,
  ]);
}

export async function updateRelease(id: string, fields: Partial<Pick<ReleaseRow, "status" | "approval" | "manifest" | "manifest_hash" | "checklist">>): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}${["approval", "manifest", "checklist"].includes(k) ? "::jsonb" : ""}`);
  }
  vals.push(id);
  await db.query(`UPDATE release_candidates SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

export async function getRelease(ownerId: string, id: string): Promise<ReleaseRow> {
  const db = await getDb();
  const rows = await db.query("SELECT r.* FROM release_candidates r JOIN projects p ON p.id = r.project_id WHERE r.id = $1 AND p.owner_id = $2", [id, ownerId]);
  if (!rows[0]) throw new NotFoundError("release candidate");
  return { ...(rows[0] as unknown as ReleaseRow), created_at: iso(rows[0].created_at) };
}

export async function listReleases(projectId: string): Promise<ReleaseRow[]> {
  const db = await getDb();
  return (await db.query("SELECT * FROM release_candidates WHERE project_id = $1 ORDER BY created_at DESC", [projectId])).map(
    (r) => ({ ...(r as unknown as ReleaseRow), created_at: iso(r.created_at) }),
  );
}
