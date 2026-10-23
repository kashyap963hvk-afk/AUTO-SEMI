import { route } from "@/lib/api";
import { getArchitecture, getProject, NotFoundError } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  const p = await getProject(user.id, id);
  const row = p.data.architecture_revision ? await getArchitecture(id, p.data.architecture_revision) : null;
  if (!row) throw new NotFoundError("architecture");
  return row;
});
