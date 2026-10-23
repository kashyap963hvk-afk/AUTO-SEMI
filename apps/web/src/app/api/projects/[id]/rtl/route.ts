import { route } from "@/lib/api";
import { getProject, getSourceRevision, listSourceRevisions, NotFoundError } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, user, { id }) => {
  const p = await getProject(user.id, id);
  const rev = Number(new URL(req.url).searchParams.get("revision") ?? p.data.source_revision);
  const row = rev ? await getSourceRevision(id, rev) : null;
  if (!row) throw new NotFoundError("source revision");
  return { ...row, revisions: await listSourceRevisions(id) };
});
