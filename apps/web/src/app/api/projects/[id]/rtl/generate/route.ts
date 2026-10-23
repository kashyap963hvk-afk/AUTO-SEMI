import { z } from "zod";
import { body, route } from "@/lib/api";
import { generateRtlRevision } from "@/lib/services/project";

export const dynamic = "force-dynamic";

export const POST = route<{ id: string }>(async (req, user, { id }) => {
  const input = await body(req, (v) => z.object({ inject_defect: z.enum(["full_off_by_one"]).nullable().optional() }).parse(v));
  const p = await generateRtlRevision(user, id, input);
  return { state: p.state, revision: p.data.source_revision };
});
