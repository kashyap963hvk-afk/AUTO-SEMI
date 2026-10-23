import { z } from "zod";
import { body, route } from "@/lib/api";
import { applyRepair, proposeRepair } from "@/lib/services/project";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, user, { id }) => proposeRepair(user, id));

export const POST = route<{ id: string }>(async (req, user, { id }) => {
  const p = await applyRepair(user, id, await body(req, (v) => z.object({ proposal_hash: z.string().regex(/^[0-9a-f]{64}$/) }).parse(v)));
  return { state: p.state, revision: p.data.source_revision };
});
