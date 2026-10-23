import { checkEndpoint, type Resolver } from "../endpointSafety";
import { ProviderError, unknownCapabilities, type AIProvider, type ConnectionClass, type ModelRequest, type ModelResponse } from "../contracts";

/**
 * OpenAI-compatible chat-completions endpoint (hosted gateways, vLLM, Ollama, LiteLLM, ...).
 * Compatibility is partial by nature, so capabilities stay "unknown" until a conformance run.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly adapter = "openai_compatible" as const;
  readonly adapterVersion = "openai_compatible@1.0.0";

  constructor(
    public readonly providerId: string,
    private readonly baseUrl: string,
    private readonly connection: ConnectionClass,
    private readonly apiKey: string | null,
    private readonly resolver?: Resolver,
  ) {}

  private async call(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<{ json: unknown; status: number; requestId: string | null; ms: number }> {
    const check = await checkEndpoint(this.baseUrl, this.connection, this.resolver);
    if (!check.ok) throw new ProviderError(`endpoint refused: ${check.reason}`, "policy");
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const started = Date.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...(init.headers ?? {}) },
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") throw new ProviderError(`request timed out after ${timeoutMs} ms`, "timeout");
      throw new ProviderError(`could not reach endpoint (${err.message})`, "network");
    }
    if (res.status >= 300 && res.status < 400) throw new ProviderError(`endpoint answered with a redirect (HTTP ${res.status}); redirects are not followed`, "policy");
    if (res.status === 401 || res.status === 403) throw new ProviderError(`authentication failed (HTTP ${res.status})`, "auth");
    const body = await res.text();
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${body.slice(0, 200)}`, "http");
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ProviderError("endpoint returned a non-JSON response", "malformed");
    }
    return { json, status: res.status, requestId: res.headers.get("x-request-id"), ms: Date.now() - started };
  }

  async probe() {
    try {
      const r = await this.call("/models", { method: "GET" }, 8000);
      const ok = Array.isArray((r.json as { data?: unknown }).data);
      return { ok, latency_ms: r.ms, detail: ok ? "GET /models answered with a model list" : "GET /models answered, but not with an OpenAI-style model list" };
    } catch (e) {
      return { ok: false, latency_ms: null, detail: (e as Error).message };
    }
  }

  async listModels() {
    const r = await this.call("/models", { method: "GET" }, 8000);
    const data = (r.json as { data?: { id?: unknown }[] }).data;
    if (!Array.isArray(data)) throw new ProviderError("model list missing `data` array", "malformed");
    return data.filter((m) => typeof m.id === "string").map((m) => ({ model_id: m.id as string }));
  }

  async getCapabilities() {
    return unknownCapabilities();
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: req.model_id,
      messages: req.messages,
      max_tokens: req.max_output_tokens,
      stream: false,
    };
    if (req.output_schema) {
      body.response_format = { type: "json_schema", json_schema: { name: req.output_schema.name, schema: req.output_schema.schema, strict: true } };
    }
    const r = await this.call("/chat/completions", { method: "POST", body: JSON.stringify(body) }, req.timeout_ms, req.signal);
    const json = r.json as {
      choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      model?: unknown;
      id?: unknown;
    };
    const choice = json.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string") throw new ProviderError("response has no choices[0].message.content string", "malformed");
    let structured: unknown = null;
    const warnings: string[] = [];
    if (req.output_schema) {
      try {
        structured = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
      } catch {
        warnings.push("structured output requested but the content was not valid JSON");
      }
    }
    const usage =
      typeof json.usage?.prompt_tokens === "number" || typeof json.usage?.completion_tokens === "number"
        ? { input_tokens: json.usage?.prompt_tokens as number | undefined, output_tokens: json.usage?.completion_tokens as number | undefined }
        : null;
    return {
      text,
      structured,
      finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      usage,
      provider_id: this.providerId,
      model_id: typeof json.model === "string" ? json.model : req.model_id,
      latency_ms: r.ms,
      request_id: r.requestId ?? (typeof json.id === "string" ? json.id : null),
      warnings,
    };
  }

  async close() {}
}
