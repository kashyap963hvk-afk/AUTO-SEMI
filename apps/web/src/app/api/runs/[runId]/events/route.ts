import { route } from "@/lib/api";
import { getRunForOwner } from "@/lib/services/system";
import { listAudit } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ runId: string }>(async (_req, user, { runId }) => {
  const run = await getRunForOwner(user.id, runId);
  const events = (await listAudit(run.project_id)).filter((e) => (e.detail as { run_id?: string }).run_id === runId);
  return { run_id: runId, status: run.status, events };
});
