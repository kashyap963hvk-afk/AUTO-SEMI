import { route } from "@/lib/api";
import { listExecutions } from "@/lib/ai/agentRuntime";
import { getProject, listAudit } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  await getProject(user.id, id);
  return { events: await listAudit(id), ai_executions: await listExecutions(id) };
});
