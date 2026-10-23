import { route } from "@/lib/api";
import { getExecutionForOwner } from "@/lib/services/system";

export const dynamic = "force-dynamic";

export const GET = route<{ eid: string }>(async (_req, user, { eid }) => getExecutionForOwner(user.id, eid));
