import { route } from "@/lib/api";
import { overview } from "@/lib/services/project";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, user, { id }) => overview(user, id));
