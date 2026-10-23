import { z } from "zod";
import { body, route } from "@/lib/api";
import { CONNECTION_LABEL } from "@/lib/ai/contracts";
import { createProvider, listProviders } from "@/lib/ai/registry";
import { WorkflowError } from "@/lib/services/project";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, user) =>
  (await listProviders(user.id)).map((p) => ({ ...p, connection_label: CONNECTION_LABEL[p.connection_class], api_key_configured: p.api_key_env ? Boolean(process.env[p.api_key_env]) : null })),
);

const NewProvider = z.object({
  display_name: z.string().max(80),
  adapter: z.enum(["openai_compatible", "anthropic"]),
  endpoint: z.string().max(300).nullable().optional(),
  connection_class: z.enum(["local_private", "self_hosted_gateway", "third_party_hosted"]),
  topology: z.enum(["same_machine", "docker_network", "private_network", "device_connector", "public_internet"]),
  api_key_env: z.string().max(80).nullable().optional(),
});

export const POST = route(async (req, user) => {
  const input = await body(req, (v) => NewProvider.parse(v));
  try {
    return await createProvider(user.id, input);
  } catch (e) {
    throw new WorkflowError((e as Error).message, 400);
  }
});
