import { route } from "@/lib/api";
import { generateArchitecture } from "@/lib/services/project";

export const dynamic = "force-dynamic";

export const POST = route<{ id: string }>(async (_req, user, { id }) => {
  const p = await generateArchitecture(user, id);
  return { state: p.state, revision: p.data.architecture_revision };
});
