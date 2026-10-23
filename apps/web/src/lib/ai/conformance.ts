import { unknownCapabilities, type AIProvider, type ModelCapabilities } from "./contracts";
import { CONFORMANCE_JSON } from "./prompts";
import type { ConformanceReport } from "./registry";

/**
 * Capability preflight (spec 23A). Uses fixed, non-proprietary prompts only: no RTL,
 * PDK data or customer documents. A capability becomes "verified" only when a
 * response passes local validation; HTTP 200 alone proves nothing.
 */
export async function runConformance(provider: AIProvider, modelId: string): Promise<{ capabilities: ModelCapabilities; report: ConformanceReport }> {
  const caps = { ...unknownCapabilities(), ...(await provider.getCapabilities(modelId)) };
  const tests: ConformanceReport["tests"] = [];
  const record = (id: string, title: string, status: "pass" | "fail" | "not_run", detail: string) => tests.push({ id, title, status, detail });

  const health = await provider.probe();
  record("connection", "Connection / authentication health probe", health.ok ? "pass" : "fail", health.detail);
  if (!health.ok) {
    for (const [id, title] of [
      ["model_id", "Model identifier validity"],
      ["text", "Simple text generation"],
      ["structured_output", "JSON-schema structured output"],
      ["timeout", "Timeout handling"],
    ]) record(id, title, "not_run", "skipped: connection probe failed");
    return { capabilities: caps, report: { at: new Date().toISOString(), model_id: modelId, tests } };
  }

  try {
    const models = await provider.listModels();
    const listed = models.some((m) => m.model_id === modelId);
    record("model_id", "Model identifier validity", listed ? "pass" : "fail", listed ? "model is listed by the endpoint" : `model "${modelId}" is not in the endpoint's model list (${models.length} listed); manual entry is allowed but unverified`);
  } catch (e) {
    record("model_id", "Model identifier validity", "not_run", `endpoint does not provide a usable model list: ${(e as Error).message}`);
  }

  try {
    const r = await provider.generate({
      model_id: modelId,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      max_output_tokens: 64,
      timeout_ms: 30000,
      metadata: { role: "conformance", prompt_id: "conformance_text" },
    });
    const ok = /\bok\b/i.test(r.text);
    caps.text = ok ? "verified" : caps.text;
    record("text", "Simple text generation", ok ? "pass" : "fail", ok ? `answered in ${r.latency_ms} ms` : `unexpected answer: ${r.text.slice(0, 80)}`);
    caps.usage_reporting = r.usage ? "verified" : caps.usage_reporting === "verified" ? "verified" : "unknown";
  } catch (e) {
    record("text", "Simple text generation", "fail", (e as Error).message);
  }

  try {
    const r = await provider.generate({
      model_id: modelId,
      messages: CONFORMANCE_JSON.build({}),
      output_schema: { name: CONFORMANCE_JSON.schemaName, schema: CONFORMANCE_JSON.jsonSchema },
      max_output_tokens: 128,
      timeout_ms: 30000,
      metadata: { role: "conformance", prompt_id: "conformance_json" },
    });
    const parsed = CONFORMANCE_JSON.output.safeParse(r.structured);
    const ok = parsed.success && parsed.data.answer === 5;
    caps.structured_output = ok ? "verified" : "unsupported";
    record("structured_output", "JSON-schema structured output", ok ? "pass" : "fail", ok ? "response validated against the schema" : `response did not validate: ${r.text.slice(0, 120)}`);
  } catch (e) {
    caps.structured_output = "unsupported";
    record("structured_output", "JSON-schema structured output", "fail", (e as Error).message);
  }

  try {
    await provider.generate({
      model_id: modelId,
      messages: [{ role: "user", content: "Count slowly from 1 to 200." }],
      max_output_tokens: 1024,
      timeout_ms: 1,
      metadata: { role: "conformance", prompt_id: "conformance_text" },
    });
    record("timeout", "Timeout handling", provider.adapter === "mock" ? "not_run" : "fail", provider.adapter === "mock" ? "in-process provider has no network timeout" : "a 1 ms timeout did not abort the request");
  } catch (e) {
    record("timeout", "Timeout handling", "pass", `request aborted cleanly: ${(e as Error).message}`);
  }

  record("tool_calling", "Tool-call proposal and argument parsing", "not_run", "no agent role in this release requires tool calling");
  record("streaming", "Streaming and cancellation", "not_run", "the agent runtime does not stream in this release");
  return { capabilities: caps, report: { at: new Date().toISOString(), model_id: modelId, tests } };
}
