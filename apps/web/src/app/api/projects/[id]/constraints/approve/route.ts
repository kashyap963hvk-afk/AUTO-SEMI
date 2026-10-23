import { z } from "zod";
import { body, route } from "@/lib/api";
import { approveConstraints } from "@/lib/services/project";

export const dynamic = "force-dynamic";

export const POST = route<{ id: string }>(async (req, user, { id }) => {
  const p = await approveConstraints(user, id, await body(req, (v) => z.object({ sdc_sha256: z.string().regex(/^[0-9a-f]{64}$/), approver_name: z.string().max(80) }).parse(v)));
  return { constraints: p.data.constraints };
});
