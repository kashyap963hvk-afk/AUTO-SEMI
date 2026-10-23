import { existsSync, readdirSync } from "node:fs";
import { getDb } from "../store/db";
import { evidenceDir, workerConfigured } from "../eda/runner";
import { NotFoundError, getProject, getSourceRevision, getSpecRevision } from "../store/repo";
import { RELEASE_POLICIES, buildChecklist, resultLevel } from "../domain/release";
import type { DesignSpec } from "../domain/spec";
import { latestRuns, releaseInputs } from "./project";
import { engineeringReport, userSummary } from "./reports";

export async function systemInfo() {
  const db = await getDb();
  const dir = evidenceDir();
  const recorded = existsSync(dir) ? readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).length : 0;
  return {
    database: { kind: db.kind, ephemeral: db.ephemeral },
    eda: {
      worker: workerConfigured() ? "configured" : "not configured",
      recorded_evidence_results: recorded,
      in_process_wasm: process.env.DEVIN_DISABLE_WASM === "1" ? [] : ["yosys (lint-elaboration, synthesis)"],
      physical: "OpenROAD Flow Scripts is not installed on any connected worker in this deployment",
    },
    notes: [
      "Execution order per stage: live EDA worker, then a recorded real run with identical inputs, then in-process Yosys (WASM), otherwise BLOCKED_TOOL_UNAVAILABLE.",
      db.ephemeral ? "Storage is ephemeral on this deployment (embedded database in /tmp). Set DATABASE_URL to a PostgreSQL database to keep projects." : db.kind === "pglite" ? "Projects are stored in embedded PostgreSQL (PGlite) on local disk." : "Projects are stored in PostgreSQL.",
    ],
  };
}

export async function buildReports(user: { id: string }, projectId: string) {
  const p = await getProject(user.id, projectId);
  if (!p.data.spec_approved_revision) throw new NotFoundError("approved specification");
  const specRow = (await getSpecRevision(projectId, p.data.spec_approved_revision))!;
  const spec = specRow.spec as DesignSpec;
  const inputs = await releaseInputs(p);
  const checklist = buildChecklist(inputs);
  const level = resultLevel({ ...inputs, releaseApproved: p.state === "RELEASE_APPROVED" || p.state === "PACKAGE_EXPORTED" });
  const latest = await latestRuns(projectId);
  const src = p.data.source_revision ? await getSourceRevision(projectId, p.data.source_revision) : null;
  return {
    user: userSummary({ name: p.name, spec, level, latest, revision: p.data.source_revision, checklist, policyLabel: RELEASE_POLICIES[p.data.release_policy].label }),
    engineering: engineeringReport({ name: p.name, spec, specRevision: specRow.revision, specHash: specRow.spec_hash, source: src, latest, checklist, level }),
  };
}

export async function getRunForOwner(ownerId: string, runId: string) {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>("SELECT r.* FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1 AND p.owner_id = $2", [runId, ownerId]);
  if (!rows[0]) throw new NotFoundError("run");
  return rows[0] as { id: string; project_id: string; status: string; result: unknown };
}

export async function getExecutionForOwner(ownerId: string, id: string) {
  const db = await getDb();
  const rows = await db.query("SELECT e.* FROM ai_executions e JOIN projects p ON p.id = e.project_id WHERE e.id = $1 AND p.owner_id = $2", [id, ownerId]);
  if (!rows[0]) throw new NotFoundError("AI execution");
  return rows[0];
}
