import { z } from "zod";
import { body, route } from "@/lib/api";
import { answerQuestion, skipExtraction } from "@/lib/services/project";

export const dynamic = "force-dynamic";

const Msg = z.union([
  z.object({ action: z.literal("skip_extraction") }),
  z.object({ key: z.string(), action: z.enum(["know", "confirm", "suggest", "unsure"]), value: z.union([z.string(), z.number(), z.boolean()]).optional() }),
]);

export const POST = route<{ id: string }>(async (req, user, { id }) => {
  const msg = await body(req, (v) => Msg.parse(v));
  const p = msg.action === "skip_extraction" ? await skipExtraction(user, id) : await answerQuestion(user, id, msg);
  return { state: p.state };
});
