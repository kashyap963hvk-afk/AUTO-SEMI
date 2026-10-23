import { z } from "zod";
import { body, route } from "@/lib/api";
import { approveArchitecture } from "@/lib/services/project";

export const dynamic = "force-dynamic";

export const POST = route<{ id: string }>(async (req, user, { id }) => {
  const p = await approveArchitecture(user, id, await body(req, (v) => z.object({ revision: z.number().int() }).parse(v)));
  return { state: p.state };
});
