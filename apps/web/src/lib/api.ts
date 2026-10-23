import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { requireUser, type SessionUser } from "./auth";
import { TransitionError } from "./domain/workflow";
import { WorkflowError } from "./services/project";
import { ConflictError, NotFoundError } from "./store/repo";

export type Ctx<P> = { params: Promise<P> };

/** Uniform error mapping for route handlers. Messages are user-facing; stack traces never are. */
export function route<P = Record<string, never>>(fn: (req: Request, user: SessionUser, params: P) => Promise<Response | unknown>) {
  return async (req: Request, ctx: Ctx<P>) => {
    try {
      const user = await requireUser();
      const params = ctx?.params ? await ctx.params : ({} as P);
      const out = await fn(req, user, params);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function errorResponse(e: unknown): Response {
  if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
  if (e instanceof ConflictError) return NextResponse.json({ error: e.message }, { status: 409 });
  if (e instanceof TransitionError) return NextResponse.json({ error: `Not allowed now: ${e.message}` }, { status: 409 });
  if (e instanceof WorkflowError) return NextResponse.json({ error: e.message }, { status: e.status });
  if (e instanceof ZodError) return NextResponse.json({ error: "invalid request", issues: e.issues.slice(0, 5) }, { status: 400 });
  if (e instanceof SyntaxError) return NextResponse.json({ error: "request body is not valid JSON" }, { status: 400 });
  console.error(e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

export async function body<T>(req: Request, parse: (v: unknown) => T): Promise<T> {
  const text = await req.text();
  if (text.length > 200_000) throw new WorkflowError("request body too large", 413);
  return parse(text ? JSON.parse(text) : {});
}
