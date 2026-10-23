import { route } from "@/lib/api";
import { latestRuns } from "@/lib/services/project";
import { getProject, getSourceRevision } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  const p = await getProject(user.id, id);
  const src = p.data.source_revision ? await getSourceRevision(id, p.data.source_revision) : null;
  const latest = await latestRuns(id);
  return {
    source: src ? Object.entries(src.file_hashes).map(([path, sha256]) => ({ path, sha256, revision: src.revision })) : [],
    runs: Object.entries(latest).flatMap(([stage, r]) => r!.result.artifacts.map((a) => ({ stage, run_id: r!.id, path: a.path, sha256: a.sha256, size: a.size }))),
  };
});
