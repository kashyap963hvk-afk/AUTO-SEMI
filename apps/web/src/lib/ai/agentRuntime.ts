import type { z } from "zod";
import { getDb } from "../store/db";
import { newId, sha256, sha256Json } from "../hash";
import { ProviderError, type CapabilityKey, type ProjectAiPolicy } from "./contracts";
import { egressDecision, missingCapabilities } from "./policy";
import { PROMPTS, type PromptId } from "./prompts";
import { getProfile, getProvider, instantiate, type ModelProfileRecord, type ProviderRecord } from "./registry";

/**
 * Bounded agent tasks. Each role is a task profile (goal, prompt, output schema,
 * required capabilities, budget, approval boundary), executed through whichever model
 * the project routes it to. The runtime enforces data policy, capability requirements
 * and schema validation, and records provenance for every call. Agents get no tools:
 * their output is a proposal that the deterministic workflow decides what to do with.
 */

export interface RoleProfile {
  role: string;
  goal: string;
  used_in_release: boolean;
  required_capabilities: CapabilityKey[];
  max_output_tokens: number;
  timeout_ms: number;
  max_attempts: number;
  approval_boundary: string;
}

export const ROLE_PROFILES: Record<string, RoleProfile> = {
  requirements_analyst: { role: "requirements_analyst", goal: "Extract explicitly stated requirement values from a plain-English description.", used_in_release: true, required_capabilities: ["text", "structured_output"], max_output_tokens: 2000, timeout_ms: 60000, max_attempts: 2, approval_boundary: "Extracted values are proposals; the user must confirm each one." },
  failure_analyst: { role: "failure_analyst", goal: "Explain a failed check in plain English from tool evidence.", used_in_release: true, required_capabilities: ["text", "structured_output"], max_output_tokens: 2000, timeout_ms: 60000, max_attempts: 2, approval_boundary: "Advisory only; tool results stay authoritative and no fix is applied without the user." },
  architecture_designer: { role: "architecture_designer", goal: "Propose module structure and trade-offs.", used_in_release: false, required_capabilities: ["text", "structured_output"], max_output_tokens: 4000, timeout_ms: 90000, max_attempts: 1, approval_boundary: "Deterministic template in this release." },
  rtl_engineer: { role: "rtl_engineer", goal: "Generate or minimally patch RTL within an approved revision.", used_in_release: false, required_capabilities: ["text", "structured_output"], max_output_tokens: 8000, timeout_ms: 120000, max_attempts: 1, approval_boundary: "Deterministic template in this release; LLM-authored RTL is not enabled." },
  verification_engineer: { role: "verification_engineer", goal: "Derive tests and assertions from requirements.", used_in_release: false, required_capabilities: ["text", "structured_output"], max_output_tokens: 8000, timeout_ms: 120000, max_attempts: 1, approval_boundary: "Checked-in regression and properties in this release." },
  rtl_reviewer: { role: "rtl_reviewer", goal: "Search for spec mismatches and synthesis hazards.", used_in_release: false, required_capabilities: ["text", "structured_output"], max_output_tokens: 4000, timeout_ms: 90000, max_attempts: 1, approval_boundary: "Advisory." },
  physical_design_analyst: { role: "physical_design_analyst", goal: "Explain parsed physical reports.", used_in_release: false, required_capabilities: ["text"], max_output_tokens: 2000, timeout_ms: 60000, max_attempts: 1, approval_boundary: "Advisory; cannot invent missing results." },
  release_auditor: { role: "release_auditor", goal: "Check the release checklist and hashes.", used_in_release: false, required_capabilities: ["text"], max_output_tokens: 2000, timeout_ms: 60000, max_attempts: 1, approval_boundary: "Deterministic checklist in this release; never signs off." },
  plain_language_reporter: { role: "plain_language_reporter", goal: "Summarise evidence for a non-engineer.", used_in_release: false, required_capabilities: ["text"], max_output_tokens: 2000, timeout_ms: 60000, max_attempts: 1, approval_boundary: "Reports are generated deterministically from evidence in this release." },
};

export class AgentBlockedError extends Error {
  constructor(message: string, public readonly executionId: string) {
    super(message);
    this.name = "AgentBlockedError";
  }
}

export interface AgentResult<T> {
  output: T;
  executionId: string;
  provider: { id: string; display_name: string; adapter: string; connection_class: string };
  model_id: string;
  mock: boolean;
  warnings: string[];
}

interface Route {
  profile: ModelProfileRecord;
  provider: ProviderRecord;
  reason: string;
}

async function resolveRoute(ownerId: string, policy: ProjectAiPolicy, role: string, profileId: string, reason: string): Promise<Route | string> {
  const profile = await getProfile(ownerId, profileId);
  if (!profile) return `model profile ${profileId} not found`;
  const provider = await getProvider(ownerId, profile.provider_id);
  if (!provider) return `provider ${profile.provider_id} not found`;
  if (!profile.allowed_roles.includes("*") && !profile.allowed_roles.includes(role)) return `model profile ${profileId} is not allowed for role ${role}`;
  return { profile, provider, reason };
}

async function record(row: Record<string, unknown>) {
  const db = await getDb();
  await db.query(
    `INSERT INTO ai_executions (id, project_id, role, prompt_id, provider_id, model_profile_id, model_id, adapter, adapter_version, capability_snapshot, input_hash, output_hash, output, route, status, latency_ms, usage, warnings, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17::jsonb,$18::jsonb,$19)`,
    [
      row.id, row.project_id ?? null, row.role, row.prompt_id, row.provider_id ?? null, row.model_profile_id ?? null, row.model_id ?? null, row.adapter ?? null,
      row.adapter_version ?? null, row.capability_snapshot ?? null, row.input_hash, row.output_hash ?? null, row.output ?? null, row.route, row.status,
      row.latency_ms ?? null, row.usage ?? null, row.warnings ?? [], row.error ?? null,
    ],
  );
}

export async function runAgentTask<T>(args: {
  ownerId: string;
  projectId: string;
  policy: ProjectAiPolicy;
  role: keyof typeof ROLE_PROFILES;
  promptId: PromptId;
  input: unknown;
  /** Extra semantic validation (e.g. quotes must appear in the user's text). */
  check?: (output: T) => { output: T; warnings: string[] };
}): Promise<AgentResult<T>> {
  const roleProfile = ROLE_PROFILES[args.role];
  const template = PROMPTS[args.promptId] as unknown as { id: string; version: string; output: z.ZodType<T>; schemaName: string; jsonSchema: Record<string, unknown>; build(i: unknown): { role: "system" | "user" | "assistant"; content: string }[] };
  const messages = template.build(args.input);
  const inputHash = sha256Json({ prompt: `${template.id}@${template.version}`, messages });
  const routes: Route[] = [];
  const routeLog: { profile: string; decision: string }[] = [];

  const primaryId = args.policy.agent_routing[args.role] ?? args.policy.default_model_profile;
  const primary = await resolveRoute(args.ownerId, args.policy, args.role, primaryId, args.policy.agent_routing[args.role] ? `per-role routing for ${args.role}` : "project default model profile");
  if (typeof primary === "string") routeLog.push({ profile: primaryId, decision: primary });
  else routes.push(primary);
  if (args.policy.fallback_model_profile && args.policy.allow_automatic_remote_fallback) {
    const fb = await resolveRoute(args.ownerId, args.policy, args.role, args.policy.fallback_model_profile, "policy-approved fallback");
    if (typeof fb === "string") routeLog.push({ profile: args.policy.fallback_model_profile, decision: fb });
    else routes.push(fb);
  }

  let lastError = "no usable route";
  for (const route of routes) {
    const egress = egressDecision(args.policy, route.provider);
    if (!egress.allowed) {
      routeLog.push({ profile: route.profile.id, decision: `refused by data policy: ${egress.reason}` });
      lastError = egress.reason;
      continue;
    }
    const missing = missingCapabilities(route.profile.capabilities, roleProfile.required_capabilities);
    if (missing.length) {
      routeLog.push({ profile: route.profile.id, decision: `refused: capabilities not verified (${missing.join(", ")}); run the conformance tests` });
      lastError = `model ${route.profile.model_id} has unverified required capabilities: ${missing.join(", ")}`;
      continue;
    }
    routeLog.push({ profile: route.profile.id, decision: `selected (${route.reason}); ${egress.reason}` });
    const provider = instantiate(route.provider);
    for (let attempt = 1; attempt <= roleProfile.max_attempts; attempt++) {
      const id = newId("aiexec");
      const base = {
        id,
        project_id: args.projectId,
        role: args.role,
        prompt_id: `${template.id}@${template.version}`,
        provider_id: route.provider.id,
        model_profile_id: route.profile.id,
        model_id: route.profile.model_id,
        adapter: provider.adapter,
        adapter_version: provider.adapterVersion,
        capability_snapshot: route.profile.capabilities,
        input_hash: inputHash,
        route: { attempt, log: routeLog, connection_class: route.provider.connection_class },
      };
      try {
        const res = await provider.generate({
          model_id: route.profile.model_id,
          messages,
          output_schema: { name: template.schemaName, schema: template.jsonSchema },
          max_output_tokens: roleProfile.max_output_tokens,
          timeout_ms: roleProfile.timeout_ms,
          metadata: { role: args.role, prompt_id: template.id, project_id: args.projectId },
        });
        const parsed = template.output.safeParse(res.structured);
        if (!parsed.success) {
          lastError = `response failed schema validation: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
          await record({ ...base, status: "schema_invalid", latency_ms: res.latency_ms, usage: res.usage, warnings: res.warnings, error: lastError, output_hash: sha256(res.text) });
          continue;
        }
        const checked = args.check ? args.check(parsed.data) : { output: parsed.data, warnings: [] };
        const warnings = [...res.warnings, ...checked.warnings];
        await record({ ...base, status: "accepted_as_proposal", latency_ms: res.latency_ms, usage: res.usage, warnings, output: checked.output, output_hash: sha256Json(checked.output) });
        await provider.close();
        return {
          output: checked.output,
          executionId: id,
          provider: { id: route.provider.id, display_name: route.provider.display_name, adapter: provider.adapter, connection_class: route.provider.connection_class },
          model_id: route.profile.model_id,
          mock: provider.adapter === "mock",
          warnings,
        };
      } catch (e) {
        lastError = e instanceof ProviderError ? `${e.kind}: ${e.message}` : (e as Error).message;
        await record({ ...base, status: "error", warnings: [], error: lastError });
      }
    }
    await provider.close();
  }
  const blockedId = newId("aiexec");
  await record({ id: blockedId, project_id: args.projectId, role: args.role, prompt_id: `${template.id}@${template.version}`, input_hash: inputHash, route: { log: routeLog }, status: "blocked", warnings: [], error: lastError });
  throw new AgentBlockedError(`BLOCKED_AI_PROVIDER: ${lastError}`, blockedId);
}

export async function listExecutions(projectId: string) {
  const db = await getDb();
  return db.query("SELECT id, role, prompt_id, provider_id, model_id, adapter, adapter_version, input_hash, output_hash, route, status, latency_ms, usage, warnings, error, created_at FROM ai_executions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50", [projectId]);
}

export async function getExecution(id: string) {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM ai_executions WHERE id = $1", [id]);
  return rows[0] ?? null;
}
