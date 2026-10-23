import { route } from "@/lib/api";
import { buildReports } from "@/lib/services/system";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, user, { id }) => {
  const kind = new URL(req.url).searchParams.get("kind") === "engineering" ? "engineering" : "user";
  const r = await buildReports(user, id);
  return new Response(kind === "engineering" ? r.engineering : r.user, { headers: { "content-type": "text/markdown; charset=utf-8" } });
});
