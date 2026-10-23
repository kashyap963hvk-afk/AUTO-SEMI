import { route } from "@/lib/api";
import { WorkflowError, runChecks } from "@/lib/services/project";
import type { Stage } from "@/lib/eda/contracts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STAGE_PATHS: Record<string, Stage> = { lint: "lint", verification: "simulation", simulation: "simulation", formal: "formal", synthesis: "synthesis", "physical-design": "physical" };

export const POST = route<{ id: string; stage: string }>(async (_req, user, { id, stage }) => {
  const s = STAGE_PATHS[stage];
  if (!s) throw new WorkflowError("unknown stage", 404);
  const events: unknown[] = [];
  const p = await runChecks(user, id, { only: s, onEvent: (e) => events.push(e) });
  return { state: p.state, events };
});
