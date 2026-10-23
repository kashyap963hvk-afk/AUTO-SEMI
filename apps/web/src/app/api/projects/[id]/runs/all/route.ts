import { errorResponse, route } from "@/lib/api";
import { runChecks, type RunEvent } from "@/lib/services/project";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Streams newline-delimited JSON progress events while the RTL check sequence runs. */
export const POST = route<{ id: string }>(async (_req, user, { id }) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: RunEvent | { type: "error"; error: string }) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        await runChecks(user, id, { onEvent: send });
      } catch (e) {
        const res = errorResponse(e);
        const msg = ((await res.json()) as { error: string }).error;
        send({ type: "error", error: msg });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
});
