import { z } from "zod";
import { body, route } from "@/lib/api";
import { createProfile, listProfiles } from "@/lib/ai/registry";
import { WorkflowError } from "@/lib/services/project";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, user) => listProfiles(user.id));

export const POST = route(async (req, user) => {
  const input = await body(req, (v) => z.object({ provider_id: z.string(), model_id: z.string().min(1).max(120), allowed_roles: z.array(z.string()).max(12).optional() }).parse(v));
  try {
    return await createProfile(user.id, input.provider_id, input.model_id, input.allowed_roles ?? ["*"]);
  } catch (e) {
    throw new WorkflowError((e as Error).message, 400);
  }
});
