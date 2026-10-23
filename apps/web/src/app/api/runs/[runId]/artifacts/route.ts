import { gunzipSync } from "node:zlib";
import { route } from "@/lib/api";
import { getRunForOwner } from "@/lib/services/system";
import { NotFoundError } from "@/lib/store/repo";
import type { StageResult } from "@/lib/eda/contracts";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { webp: "image/webp", png: "image/png", gds: "application/octet-stream", vcd: "text/plain", rpt: "text/plain", v: "text/plain", txt: "text/plain" };

/** Serves one artifact of a run the caller owns, decoding gzip+base64 binaries. */
export const GET = route<{ runId: string }>(async (req, user, { runId }) => {
  const path = new URL(req.url).searchParams.get("path") ?? "";
  const run = await getRunForOwner(user.id, runId);
  const a = (run.result as StageResult).artifacts.find((x) => x.path === path);
  if (!a || a.content == null) throw new NotFoundError("artifact");
  const body = a.encoding === "gzip+base64" ? gunzipSync(Buffer.from(a.content, "base64")) : Buffer.from(a.content, "utf8");
  const name = path.split("/").pop()!;
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream",
      "content-disposition": `${name.endsWith(".gds") ? "attachment" : "inline"}; filename="${name.replace(/[^A-Za-z0-9_.-]/g, "_")}"`,
      "x-sha256": a.sha256,
      "cache-control": "private, max-age=3600",
    },
  });
});
