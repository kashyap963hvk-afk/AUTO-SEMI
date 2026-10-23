import { z } from "zod";
import { body, route } from "@/lib/api";
import { setAiPolicy } from "@/lib/services/project";
import { getProject } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

const Policy = z.object({
  schema_version: z.literal("1.0"),
  data_egress: z.enum(["local_only", "approved_providers_only", "user_authorized_remote"]),
  approved_provider_ids: z.array(z.string()).max(20),
  remote_authorized_at: z.string().nullable(),
  default_model_profile: z.string(),
  agent_routing: z.record(z.string()),
  allow_automatic_remote_fallback: z.boolean(),
  fallback_model_profile: z.string().nullable(),
});

export const GET = route<{ id: string }>(async (_req, user, { id }) => (await getProject(user.id, id)).ai_policy);

export const POST = route<{ id: string }>(async (req, user, { id }) => (await setAiPolicy(user, id, await body(req, (v) => Policy.parse(v)))).ai_policy);
