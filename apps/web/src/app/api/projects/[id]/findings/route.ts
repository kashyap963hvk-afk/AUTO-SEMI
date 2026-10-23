import { route } from "@/lib/api";
import { latestRuns } from "@/lib/services/project";
import { getProject } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  await getProject(user.id, id);
  const latest = await latestRuns(id);
  return Object.entries(latest).flatMap(([stage, r]) => r!.result.findings.map((f) => ({ stage, run_id: r!.id, source_revision: r!.source_revision, ...f })));
});
