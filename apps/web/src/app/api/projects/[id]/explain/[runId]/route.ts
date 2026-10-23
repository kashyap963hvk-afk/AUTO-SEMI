import { route } from "@/lib/api";
import { explainRun } from "@/lib/services/project";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = route<{ id: string; runId: string }>(async (_req, user, { id, runId }) => explainRun(user, id, runId));
