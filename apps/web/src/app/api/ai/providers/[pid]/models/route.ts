import { route } from "@/lib/api";
import { getProvider, instantiate } from "@/lib/ai/registry";
import { WorkflowError } from "@/lib/services/project";
import { NotFoundError } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ pid: string }>(async (_req, user, { pid }) => {
  const p = await getProvider(user.id, pid);
  if (!p) throw new NotFoundError("provider");
  try {
    return { models: await instantiate(p).listModels(), note: "Discovery can be incomplete; you may enter a model ID manually. A listed name does not prove any capability." };
  } catch (e) {
    throw new WorkflowError(`model discovery failed: ${(e as Error).message}. Enter the model ID manually.`, 502);
  }
});
