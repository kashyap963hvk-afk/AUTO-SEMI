import { z } from "zod";
import { body, route } from "@/lib/api";
import { setReleasePolicy } from "@/lib/services/project";

export const dynamic = "force-dynamic";

export const POST = route<{ id: string }>(async (req, user, { id }) => {
  const { policy } = await body(req, (v) => z.object({ policy: z.enum(["rtl-prototype", "open-pdk-physical-prototype"]) }).parse(v));
  const p = await setReleasePolicy(user, id, policy);
  return { release_policy: p.data.release_policy };
});
