import { z } from "zod";
import { body, route } from "@/lib/api";
import { createProject } from "@/lib/services/project";
import { listProjects } from "@/lib/store/repo";
import { userStatus } from "@/lib/domain/workflow";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = route(async (_req, user) =>
  (await listProjects(user.id)).map((p) => ({ id: p.id, name: p.name, state: p.state, status: userStatus(p.state), updated_at: p.updated_at })),
);

const Create = z.object({ name: z.string().max(80).default(""), description: z.string().min(1).max(4000) });
export const POST = route(async (req, user) => {
  const input = await body(req, (v) => Create.parse(v));
  const p = await createProject(user, input);
  return { id: p.id, state: p.state };
});
