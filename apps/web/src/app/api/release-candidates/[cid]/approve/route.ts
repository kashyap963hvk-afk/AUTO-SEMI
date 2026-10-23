import { z } from "zod";
import { body, route } from "@/lib/api";
import { approveRelease } from "@/lib/services/release";

export const dynamic = "force-dynamic";

const Approve = z.object({ approver_name: z.string().max(80), approver_role: z.string().max(80), qualified_reviewer: z.boolean(), accepted_open_issues: z.array(z.string()).max(30) });

export const POST = route<{ cid: string }>(async (req, user, { cid }) => approveRelease(user, cid, await body(req, (v) => Approve.parse(v))));
