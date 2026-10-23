import { route } from "@/lib/api";
import { WorkflowError } from "@/lib/services/project";
import { verifyPackage } from "@/lib/services/release";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new WorkflowError("package too large", 413);
  return verifyPackage(buf);
});
