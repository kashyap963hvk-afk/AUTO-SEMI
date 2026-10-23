import type { AIProvider, ModelCapabilities, ModelRequest, ModelResponse } from "../contracts";
import type { FailureExplainOutput, ReqExtractOutput } from "../prompts";

/**
 * Deterministic mock provider: rule-based, offline, no network. Used by CI, tests,
 * offline development and the default demo. Every response it produces is labelled
 * as mock output in the UI and in AI execution records.
 */

function dataBlock(req: ModelRequest): string {
  const user = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const m = user.match(/<data>\n([\s\S]*)\n<\/data>/);
  return m ? m[1] : user;
}

export function mockExtract(text: string): ReqExtractOutput {
  const fields: ReqExtractOutput["fields"] = [];
  const add = (key: ReqExtractOutput["fields"][number]["key"], value: string, quote: string) => {
    if (!fields.some((f) => f.key === key)) fields.push({ key, value, quote });
  };
  let m: RegExpMatchArray | null;
  if ((m = text.match(/(\d{1,3})\s*-?\s*bits?\b/i))) add("data_width", m[1], m[0]);
  else if ((m = text.match(/\b(bytes?)\b/i))) add("data_width", "8", m[0]);
  if ((m = text.match(/\b(\d{1,4})\s+(?:[a-z-]+\s+)?(?:entries|values|items|words|slots|elements|samples|readings|numbers|bytes|messages)\b/i))) add("depth", m[1], m[0]);
  else if ((m = text.match(/\bdepth\s*(?:of|=|:)?\s*(\d{1,4})\b/i))) add("depth", m[1], m[0]);
  else if ((m = text.match(/\b(\d{1,4})\s*-?\s*deep\b/i))) add("depth", m[1], m[0]);
  if ((m = text.match(/(\d+(?:\.\d+)?)\s*mhz/i))) add("clock_mhz", m[1], m[0]);
  if ((m = text.match(/sky\s*-?\s*130/i))) add("target_pdk", "sky130hd", m[0]);
  else if ((m = text.match(/gf\s*-?\s*180/i))) add("target_pdk", "gf180", m[0]);
  if ((m = text.match(/\basync(?:hronous)?\s*,?\s*active[- ]low\s+reset\b/i))) add("reset_style", "async_active_low", m[0]);
  else if ((m = text.match(/\bsync(?:hronous)?\s*,?\s*active[- ]low\s+reset\b/i))) add("reset_style", "sync_active_low", m[0]);
  else if ((m = text.match(/\bsync(?:hronous)?\s*,?\s*active[- ]high\s+reset\b/i))) add("reset_style", "sync_active_high", m[0]);
  if ((m = text.match(/\b(prototype|learning|hobby|class project|student|experiment\w*)\b/i))) add("intended_use", "prototype", m[0]);
  else if ((m = text.match(/\b(commercial|production|mass[- ]produc\w+|manufactur\w+)\b/i))) add("intended_use", "commercial", m[0]);
  const isFifo = /\b(fifo|buffer|queue|first[- ]in)\b/i.test(text);
  const notes: string[] = [];
  const depths = [...text.matchAll(/\b(\d{1,4})\s+(?:[a-z-]+\s+)?(?:entries|values|items|words|slots|elements|samples|readings|numbers|bytes|messages)\b/gi)].map((x) => x[1]);
  const widths = [...text.matchAll(/(\d{1,3})\s*-?\s*bits?\b/gi)].map((x) => x[1]);
  for (const [name, vals] of [["depth", depths], ["data width", widths]] as const) {
    const uniq = [...new Set(vals)];
    if (uniq.length > 1) notes.push(`Your description gives conflicting values for ${name} (${uniq.join(" vs ")}); the first is only a proposal, so please confirm the one you want.`);
  }
  if (/\b(two|2|multiple|dual)\s+clocks?\b|\basync(hronous)?\s+fifo\b|clock[- ]domain/i.test(text)) notes.push("Multiple clock domains were mentioned; this release supports a single clock only.");
  if (/\b(almost[- ]full|almost[- ]empty)\b/i.test(text)) notes.push("Almost-full/almost-empty flags are out of scope for this release.");
  if (/\b(analog|adc|dac|pll|rf)\b/i.test(text)) notes.push("Analog/mixed-signal blocks are out of scope for this release.");
  const node = text.match(/\b(\d{1,2})\s*-?\s*nm\b/i);
  if (node && Number(node[1]) < 130) notes.push(`A ${node[1]} nm process is not supported: this release targets the public 130 nm (SKY130) and 180 nm (GF180MCU) PDKs, and advanced nodes need foundry-licensed collateral.`);
  if (/\b(\d+)\s*(?:kb|kib|kilobytes?|mb)\b/i.test(text)) notes.push("A total size was given in bytes; please confirm the data width and the number of entries separately.");
  return { design_kind: isFifo ? "fifo" : "other", fields, notes };
}

export function mockExplain(input: {
  stage: string;
  summary: string;
  findings: { code: string; message: string }[];
  failing_tests?: { name: string; message?: string | null; covers: string[] }[];
  failing_properties?: { location: string; covers: string[]; step?: number | null }[];
}): FailureExplainOutput {
  const tests = input.failing_tests ?? [];
  const props = input.failing_properties ?? [];
  const reqs = [...new Set([...tests.flatMap((t) => t.covers), ...props.flatMap((p) => p.covers)])].sort();
  const evidence = [
    ...tests.slice(0, 4).map((t) => `${t.name}: ${t.message ?? "failed"}`),
    ...props.slice(0, 3).map((p) => `assertion at ${p.location} fails${p.step != null ? ` after ${p.step} clock cycles` : ""}`),
    ...input.findings.filter((f) => !f.code.startsWith("TEST_")).slice(0, 3).map((f) => `${f.code}: ${f.message}`),
  ]
    .slice(0, 8)
    .map((e) => (e.length > 280 ? `${e.slice(0, 277)}...` : e));
  const text = evidence.join(" ").toLowerCase();
  let cause = "The evidence does not point to a single line; compare the failing checks with the requirements they cover.";
  if (/\bfull=/.test(text) || /full\b.*model holds/.test(text)) cause = "The full flag disagrees with the number of stored items. The full-flag comparison in the RTL most likely uses the wrong threshold.";
  else if (/\bempty=/.test(text)) cause = "The empty flag disagrees with the number of stored items. Check the empty-flag logic.";
  else if (/rd_data/.test(text)) cause = "The data read out differs from what was written. Check the read/write pointer and storage logic.";
  else if (input.stage === "lint") cause = "The source has a coding problem the linter flags. See the first finding.";
  return {
    summary: `The ${input.stage} check failed: ${input.summary}.`,
    likely_cause: cause,
    evidence,
    suggested_next_step:
      input.stage === "lint"
        ? "Fix the flagged line and re-run lint. Do not add a waiver unless an engineer approves it."
        : "Compare the RTL with the approved template, propose a minimal fix as a new revision, and re-run every check. Tests and assertions stay unchanged.",
    affects_requirements: reqs,
  };
}

export class MockProvider implements AIProvider {
  readonly adapter = "mock" as const;
  readonly adapterVersion = "mock@1.0.0";
  constructor(public readonly providerId: string) {}

  async probe() {
    return { ok: true, latency_ms: 0, detail: "deterministic in-process provider" };
  }
  async listModels() {
    return [{ model_id: "deterministic-rules-v1", display_name: "Built-in deterministic rules (mock)" }];
  }
  async getCapabilities(): Promise<ModelCapabilities> {
    return { text: "verified", structured_output: "verified", tool_calling: "unsupported", streaming: "unsupported", cancellation: "unsupported", usage_reporting: "unsupported", image_input: "unsupported" };
  }
  async generate(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    let structured: unknown;
    switch (req.metadata.prompt_id) {
      case "req_extract":
        structured = mockExtract(dataBlock(req));
        break;
      case "failure_explain":
        structured = mockExplain(JSON.parse(dataBlock(req)));
        break;
      case "conformance_json":
        structured = { answer: 5 };
        break;
      case "conformance_text":
        structured = null;
        break;
      default:
        throw new Error(`mock provider has no deterministic handler for prompt ${req.metadata.prompt_id}`);
    }
    const text = structured === null ? "OK" : JSON.stringify(structured);
    return {
      text,
      structured,
      finish_reason: "end",
      usage: null,
      provider_id: this.providerId,
      model_id: req.model_id,
      latency_ms: Date.now() - started,
      request_id: null,
      warnings: ["MOCK: deterministic rule-based output, not produced by a language model"],
    };
  }
  async close() {}
}
