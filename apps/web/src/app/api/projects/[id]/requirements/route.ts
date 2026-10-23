import { route } from "@/lib/api";
import { interviewState } from "@/lib/services/project";
import { getProject } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  const p = await getProject(user.id, id);
  return { fields: p.data.fields, conversation: p.data.conversation, extraction: p.data.extraction, interview: interviewState(p) };
});
