import { route } from "@/lib/api";
import { exportRelease } from "@/lib/services/release";

export const dynamic = "force-dynamic";

export const POST = route<{ cid: string }>(async (_req, user, { cid }) => {
  const { zip, filename, manifest_sha256 } = await exportRelease(user, cid);
  return new Response(Buffer.from(zip), {
    headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${filename}"`, "x-manifest-sha256": manifest_sha256 },
  });
});
