import { route } from "@/lib/api";
import { getProject, listRuns } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  await getProject(user.id, id);
  return (await listRuns(id)).map((r) => ({ id: r.id, stage: r.stage, status: r.status, source_revision: r.source_revision, execution_mode: r.execution_mode, input_hash: r.input_hash, summary: r.result.summary, created_at: r.created_at }));
});
