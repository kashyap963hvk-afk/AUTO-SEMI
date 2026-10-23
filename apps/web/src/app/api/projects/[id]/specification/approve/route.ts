import { z } from "zod";
import { body, route } from "@/lib/api";
import { approveSpecification } from "@/lib/services/project";

export const dynamic = "force-dynamic";

const Approve = z.object({ revision: z.number().int(), accepted: z.array(z.string()).max(20), acknowledge_physical_unknowns: z.boolean().default(false) });

export const POST = route<{ id: string }>(async (req, user, { id }) => {
  const p = await approveSpecification(user, id, await body(req, (v) => Approve.parse(v)));
  return { state: p.state, revision: p.data.spec_approved_revision };
});
