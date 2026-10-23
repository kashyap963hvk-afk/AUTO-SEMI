/**
 * Provider-neutral AI contract (spec v1.1 section 23A). Workflow and agent code import
 * only from this module; vendor SDKs are confined to src/lib/ai/adapters/.
 */

export type CapabilityState = "verified" | "unsupported" | "unknown";

export const CAPABILITY_KEYS = [
  "text",
  "structured_output",
  "tool_calling",
  "streaming",
  "cancellation",
  "usage_reporting",
  "image_input",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type ModelCapabilities = Record<CapabilityKey, CapabilityState>;

export function unknownCapabilities(): ModelCapabilities {
  return Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, "unknown"])) as ModelCapabilities;
}

export type AdapterType = "mock" | "openai_compatible" | "anthropic";
export type ConnectionClass = "in_process" | "local_private" | "self_hosted_gateway" | "third_party_hosted";
export type Topology = "in_process" | "same_machine" | "docker_network" | "private_network" | "device_connector" | "public_internet";

export const CONNECTION_LABEL: Record<ConnectionClass, string> = {
  in_process: "built-in (runs inside this app, no network)",
  local_private: "local/private endpoint",
  self_hosted_gateway: "self-hosted gateway",
  third_party_hosted: "third-party hosted API",
};

export interface ProviderHealth {
  ok: boolean;
  latency_ms: number | null;
  detail: string;
}

export interface ModelDescriptor {
  model_id: string;
  display_name?: string;
  context_window?: number; // only when reported by the endpoint
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  model_id: string;
  messages: ChatMessage[];
  /** JSON Schema the response must satisfy. Responses are re-validated locally either way. */
  output_schema?: { name: string; schema: Record<string, unknown> };
  max_output_tokens: number;
  timeout_ms: number;
  signal?: AbortSignal;
  metadata: { role: string; prompt_id: string; project_id?: string };
}

export interface ModelResponse {
  text: string;
  structured: unknown | null;
  finish_reason: string | null;
  usage: { input_tokens?: number; output_tokens?: number } | null; // null when the provider reports none
  provider_id: string;
  model_id: string;
  latency_ms: number;
  request_id: string | null;
  warnings: string[];
}

export interface AIProvider {
  readonly providerId: string;
  readonly adapter: AdapterType;
  readonly adapterVersion: string;
  probe(): Promise<ProviderHealth>;
  listModels(): Promise<ModelDescriptor[]>;
  /** Capabilities the adapter itself can attest without a conformance run; everything else stays unknown. */
  getCapabilities(modelId: string): Promise<ModelCapabilities>;
  generate(request: ModelRequest): Promise<ModelResponse>;
  close(): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: "timeout" | "auth" | "network" | "http" | "malformed" | "policy" | "config",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type DataEgressPolicy = "local_only" | "approved_providers_only" | "user_authorized_remote";

export interface ProjectAiPolicy {
  schema_version: "1.0";
  data_egress: DataEgressPolicy;
  approved_provider_ids: string[];
  remote_authorized_at: string | null;
  default_model_profile: string;
  agent_routing: Partial<Record<string, string>>;
  allow_automatic_remote_fallback: boolean;
  fallback_model_profile: string | null;
}

export const BUILTIN_PROVIDER_ID = "builtin-mock";
export const BUILTIN_MODEL_PROFILE_ID = "builtin-deterministic";

export function defaultAiPolicy(): ProjectAiPolicy {
  return {
    schema_version: "1.0",
    data_egress: "local_only",
    approved_provider_ids: [],
    remote_authorized_at: null,
    default_model_profile: BUILTIN_MODEL_PROFILE_ID,
    agent_routing: {},
    allow_automatic_remote_fallback: false,
    fallback_model_profile: null,
  };
}
