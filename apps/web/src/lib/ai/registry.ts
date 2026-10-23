import { getDb } from "../store/db";
import { newId } from "../hash";
import { AnthropicProvider } from "./adapters/anthropic";
import { MockProvider } from "./adapters/mock";
import { OpenAICompatibleProvider } from "./adapters/openaiCompatible";
import {
  BUILTIN_MODEL_PROFILE_ID,
  BUILTIN_PROVIDER_ID,
  unknownCapabilities,
  type AdapterType,
  type AIProvider,
  type ConnectionClass,
  type ModelCapabilities,
  type Topology,
} from "./contracts";
import { checkEndpoint, readSecret, SECRET_ENV_PATTERN, type Resolver } from "./endpointSafety";

/** Provider connection metadata. Never holds a credential, only the env var name that does. */
export interface ProviderRecord {
  id: string;
  owner_id: string | null;
  display_name: string;
  adapter: AdapterType;
  endpoint: string | null;
  connection_class: ConnectionClass;
  topology: Topology;
  api_key_env: string | null;
  enabled: boolean;
  last_probe: { ok: boolean; detail: string; at: string; latency_ms: number | null } | null;
}

export interface ModelProfileRecord {
  id: string;
  owner_id: string | null;
  provider_id: string;
  model_id: string;
  capabilities: ModelCapabilities;
  conformance: ConformanceReport | null;
  allowed_roles: string[];
}

export interface ConformanceReport {
  at: string;
  model_id: string;
  tests: { id: string; title: string; status: "pass" | "fail" | "not_run"; detail: string }[];
}

export const BUILTIN_PROVIDER: ProviderRecord = {
  id: BUILTIN_PROVIDER_ID,
  owner_id: null,
  display_name: "Built-in deterministic engine (mock provider)",
  adapter: "mock",
  endpoint: null,
  connection_class: "in_process",
  topology: "in_process",
  api_key_env: null,
  enabled: true,
  last_probe: null,
};

export const BUILTIN_PROFILE: ModelProfileRecord = {
  id: BUILTIN_MODEL_PROFILE_ID,
  owner_id: null,
  provider_id: BUILTIN_PROVIDER_ID,
  model_id: "deterministic-rules-v1",
  capabilities: { text: "verified", structured_output: "verified", tool_calling: "unsupported", streaming: "unsupported", cancellation: "unsupported", usage_reporting: "unsupported", image_input: "unsupported" },
  conformance: null,
  allowed_roles: ["*"],
};

/** Test hook: a DNS resolver override for the OpenAI-compatible adapter. */
let resolverOverride: Resolver | undefined;
export function setResolverForTests(r: Resolver | undefined) {
  resolverOverride = r;
}

export function instantiate(p: ProviderRecord): AIProvider {
  switch (p.adapter) {
    case "mock":
      return new MockProvider(p.id);
    case "openai_compatible":
      if (!p.endpoint) throw new Error("OpenAI-compatible provider has no endpoint");
      return new OpenAICompatibleProvider(p.id, p.endpoint, p.connection_class, readSecret(p.api_key_env), resolverOverride);
    case "anthropic":
      return new AnthropicProvider(p.id, readSecret(p.api_key_env));
  }
}

function rowToProvider(r: Record<string, unknown>): ProviderRecord {
  return {
    id: r.id as string,
    owner_id: (r.owner_id as string) ?? null,
    display_name: r.display_name as string,
    adapter: r.adapter as AdapterType,
    endpoint: (r.endpoint as string) ?? null,
    connection_class: r.connection_class as ConnectionClass,
    topology: r.topology as Topology,
    api_key_env: (r.api_key_env as string) ?? null,
    enabled: Boolean(r.enabled),
    last_probe: (r.last_probe as ProviderRecord["last_probe"]) ?? null,
  };
}

function rowToProfile(r: Record<string, unknown>): ModelProfileRecord {
  return {
    id: r.id as string,
    owner_id: (r.owner_id as string) ?? null,
    provider_id: r.provider_id as string,
    model_id: r.model_id as string,
    capabilities: r.capabilities as ModelCapabilities,
    conformance: (r.conformance as ConformanceReport) ?? null,
    allowed_roles: r.allowed_roles as string[],
  };
}

export async function listProviders(ownerId: string): Promise<ProviderRecord[]> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM ai_providers WHERE owner_id = $1 ORDER BY created_at", [ownerId]);
  return [BUILTIN_PROVIDER, ...rows.map(rowToProvider)];
}

export async function getProvider(ownerId: string, id: string): Promise<ProviderRecord | null> {
  if (id === BUILTIN_PROVIDER_ID) return BUILTIN_PROVIDER;
  const db = await getDb();
  const rows = await db.query("SELECT * FROM ai_providers WHERE id = $1 AND owner_id = $2", [id, ownerId]);
  return rows[0] ? rowToProvider(rows[0]) : null;
}

export interface NewProviderInput {
  display_name: string;
  adapter: AdapterType;
  endpoint?: string | null;
  connection_class: ConnectionClass;
  topology: Topology;
  api_key_env?: string | null;
}

export async function createProvider(ownerId: string, input: NewProviderInput): Promise<ProviderRecord> {
  if (input.adapter === "mock") throw new Error("the mock provider is built in and cannot be added again");
  if (!input.display_name.trim() || input.display_name.length > 80) throw new Error("display name must be 1-80 characters");
  if (input.api_key_env && !SECRET_ENV_PATTERN.test(input.api_key_env)) throw new Error("API key must be referenced by an environment variable name starting with DEVIN_AI_ (the key itself is never stored)");
  let endpoint: string | null = null;
  let connection = input.connection_class;
  if (input.adapter === "anthropic") {
    endpoint = "https://api.anthropic.com";
    connection = "third_party_hosted";
    if (!input.api_key_env) throw new Error("the Anthropic adapter needs an API key environment variable");
  } else {
    if (!input.endpoint) throw new Error("an endpoint base URL is required");
    if (connection === "in_process") throw new Error("choose local/private, self-hosted gateway or third-party hosted");
    const check = await checkEndpoint(input.endpoint, connection, resolverOverride);
    if (!check.ok) throw new Error(`endpoint rejected: ${check.reason}`);
    endpoint = check.url!.toString().replace(/\/$/, "");
  }
  const id = newId("prov");
  const db = await getDb();
  await db.query(
    "INSERT INTO ai_providers (id, owner_id, display_name, adapter, endpoint, connection_class, topology, api_key_env) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, ownerId, input.display_name.trim(), input.adapter, endpoint, connection, input.topology, input.api_key_env ?? null],
  );
  return (await getProvider(ownerId, id))!;
}

export async function recordProbe(ownerId: string, id: string, probe: ProviderRecord["last_probe"]): Promise<void> {
  if (id === BUILTIN_PROVIDER_ID) return;
  const db = await getDb();
  await db.query("UPDATE ai_providers SET last_probe = $1::jsonb, updated_at = now() WHERE id = $2 AND owner_id = $3", [probe, id, ownerId]);
}

export async function listProfiles(ownerId: string): Promise<ModelProfileRecord[]> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM ai_model_profiles WHERE owner_id = $1 ORDER BY created_at", [ownerId]);
  return [BUILTIN_PROFILE, ...rows.map(rowToProfile)];
}

export async function getProfile(ownerId: string, id: string): Promise<ModelProfileRecord | null> {
  if (id === BUILTIN_MODEL_PROFILE_ID) return BUILTIN_PROFILE;
  const db = await getDb();
  const rows = await db.query("SELECT * FROM ai_model_profiles WHERE id = $1 AND owner_id = $2", [id, ownerId]);
  return rows[0] ? rowToProfile(rows[0]) : null;
}

export async function createProfile(ownerId: string, providerId: string, modelId: string, allowedRoles: string[] = ["*"]): Promise<ModelProfileRecord> {
  const provider = await getProvider(ownerId, providerId);
  if (!provider || provider.id === BUILTIN_PROVIDER_ID) throw new Error("unknown provider");
  if (!/^[A-Za-z0-9._:/@-]{1,120}$/.test(modelId)) throw new Error("model ID contains unsupported characters");
  const id = newId("model");
  const db = await getDb();
  await db.query("INSERT INTO ai_model_profiles (id, owner_id, provider_id, model_id, capabilities, allowed_roles) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)", [
    id,
    ownerId,
    providerId,
    modelId,
    unknownCapabilities(),
    allowedRoles,
  ]);
  return (await getProfile(ownerId, id))!;
}

export async function saveConformance(ownerId: string, profileId: string, caps: ModelCapabilities, report: ConformanceReport): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE ai_model_profiles SET capabilities = $1::jsonb, conformance = $2::jsonb, updated_at = now() WHERE id = $3 AND owner_id = $4", [caps, report, profileId, ownerId]);
}
