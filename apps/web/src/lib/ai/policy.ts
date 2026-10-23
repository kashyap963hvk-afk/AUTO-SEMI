import type { CapabilityKey, ModelCapabilities, ProjectAiPolicy } from "./contracts";
import type { ProviderRecord } from "./registry";

/** Data-egress decision made before every model call (spec 23A "Local versus remote data policy"). */
export interface EgressDecision {
  allowed: boolean;
  reason: string;
}

export function egressDecision(policy: ProjectAiPolicy, provider: ProviderRecord): EgressDecision {
  const cls = provider.connection_class;
  if (!provider.enabled) return { allowed: false, reason: `provider ${provider.display_name} is disabled` };
  if (cls === "in_process") return { allowed: true, reason: "built-in provider: project content never leaves this application" };
  switch (policy.data_egress) {
    case "local_only":
      if (cls === "local_private" || cls === "self_hosted_gateway") return { allowed: true, reason: `local_only policy: ${cls.replace(/_/g, " ")} endpoint is permitted` };
      return { allowed: false, reason: "local_only policy: project content may not be sent to a third-party hosted API" };
    case "approved_providers_only":
      if (policy.approved_provider_ids.includes(provider.id)) return { allowed: true, reason: "provider is on this project's approved list" };
      return { allowed: false, reason: "approved_providers_only policy: this provider is not on the project's approved list" };
    case "user_authorized_remote":
      if (cls !== "third_party_hosted") return { allowed: true, reason: "non-remote endpoint" };
      if (policy.remote_authorized_at) return { allowed: true, reason: `remote providers authorised by the project owner at ${policy.remote_authorized_at}` };
      return { allowed: false, reason: "user_authorized_remote policy: the owner has not yet approved the remote-provider disclosure" };
  }
}

export function missingCapabilities(caps: ModelCapabilities, required: CapabilityKey[]): CapabilityKey[] {
  return required.filter((k) => caps[k] !== "verified");
}
