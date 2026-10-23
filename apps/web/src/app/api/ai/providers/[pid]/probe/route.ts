import { route } from "@/lib/api";
import { getProvider, instantiate, recordProbe } from "@/lib/ai/registry";
import { NotFoundError } from "@/lib/store/repo";

export const dynamic = "force-dynamic";

export const POST = route<{ pid: string }>(async (_req, user, { pid }) => {
  const p = await getProvider(user.id, pid);
  if (!p) throw new NotFoundError("provider");
  let probe;
  try {
    const health = await instantiate(p).probe();
    probe = { ...health, at: new Date().toISOString() };
  } catch (e) {
    probe = { ok: false, latency_ms: null, detail: (e as Error).message, at: new Date().toISOString() };
  }
  await recordProbe(user.id, pid, probe);
  return { ...probe, topology: p.topology, connection_class: p.connection_class };
});
