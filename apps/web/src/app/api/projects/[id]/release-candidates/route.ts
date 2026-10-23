import { route } from "@/lib/api";
import { createReleaseCandidate } from "@/lib/services/release";
import { getProject, listReleases } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  await getProject(user.id, id);
  return listReleases(id);
});

export const POST = route<{ id: string }>(async (_req, user, { id }) => createReleaseCandidate(user, id));
