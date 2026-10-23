import { route } from "@/lib/api";
import { getProject, getSpecRevision, listSpecRevisions, NotFoundError } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, user, { id }) => {
  const p = await getProject(user.id, id);
  const rev = Number(new URL(req.url).searchParams.get("revision") ?? p.data.spec_revision);
  const row = rev ? await getSpecRevision(id, rev) : null;
  if (!row) throw new NotFoundError("specification revision");
  return { ...row, revisions: await listSpecRevisions(id) };
});
