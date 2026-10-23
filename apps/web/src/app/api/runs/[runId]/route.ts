import { route } from "@/lib/api";
import { getRunForOwner } from "@/lib/services/system";

export const dynamic = "force-dynamic";

export const GET = route<{ runId: string }>(async (_req, user, { runId }) => getRunForOwner(user.id, runId));
