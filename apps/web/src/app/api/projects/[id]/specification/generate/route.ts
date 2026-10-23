import { route } from "@/lib/api";
import { generateSpecification } from "@/lib/services/project";

export const dynamic = "force-dynamic";

export const POST = route<{ id: string }>(async (_req, user, { id }) => {
  const p = await generateSpecification(user, id);
  return { state: p.state, revision: p.data.spec_revision };
});
