import { z } from "zod";
import { body, route } from "@/lib/api";
import { runConformance } from "@/lib/ai/conformance";
import { createProfile, getProvider, instantiate, listProfiles, saveConformance } from "@/lib/ai/registry";
import { NotFoundError } from "@/lib/store/repo";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = route<{ pid: string }>(async (req, user, { pid }) => {
  const { model_id } = await body(req, (v) => z.object({ model_id: z.string().min(1).max(120) }).parse(v));
  const p = await getProvider(user.id, pid);
  if (!p) throw new NotFoundError("provider");
  const existing = (await listProfiles(user.id)).find((m) => m.provider_id === pid && m.model_id === model_id);
  const profile = existing ?? (await createProfile(user.id, pid, model_id));
  const { capabilities, report } = await runConformance(instantiate(p), model_id);
  if (profile.owner_id) await saveConformance(user.id, profile.id, capabilities, report);
  return { profile_id: profile.id, capabilities, report };
});
