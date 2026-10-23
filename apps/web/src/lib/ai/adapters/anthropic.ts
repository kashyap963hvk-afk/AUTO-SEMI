import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, unknownCapabilities, type AIProvider, type ModelRequest, type ModelResponse } from "../contracts";

/**
 * Native Anthropic Messages API adapter. The only module that imports the Anthropic SDK.
 * The model ID is whatever the user configured on the model profile; nothing is hardcoded.
 */
export class AnthropicProvider implements AIProvider {
  readonly adapter = "anthropic" as const;
  readonly adapterVersion = "anthropic@1.0.0";
  private readonly client: Anthropic;

  constructor(public readonly providerId: string, apiKey: string | null) {
    if (!apiKey) throw new ProviderError("no API key: set the configured DEVIN_AI_* environment variable", "config");
    this.client = new Anthropic({ apiKey, maxRetries: 1 });
  }

  private wrap(e: unknown): ProviderError {
    if (e instanceof ProviderError) return e;
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError(`authentication failed (${e.status})`, "auth");
    if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("request timed out", "timeout");
    if (e instanceof Anthropic.APIConnectionError) return new ProviderError(`could not reach the Anthropic API (${e.message})`, "network");
    if (e instanceof Anthropic.APIError) return new ProviderError(`HTTP ${e.status}: ${e.message}`.slice(0, 300), "http");
    return new ProviderError((e as Error).message, "malformed");
  }

  async probe() {
    const started = Date.now();
    try {
      const page = await this.client.models.list({ limit: 1 }, { timeout: 8000 });
      return { ok: Array.isArray(page.data), latency_ms: Date.now() - started, detail: "GET /v1/models answered" };
    } catch (e) {
      return { ok: false, latency_ms: null, detail: this.wrap(e).message };
    }
  }

  async listModels() {
    try {
      const out: { model_id: string; display_name?: string; context_window?: number }[] = [];
      for await (const m of this.client.models.list({ limit: 100 }, { timeout: 10000 })) {
        const window = (m as unknown as { max_input_tokens?: number }).max_input_tokens;
        out.push({ model_id: m.id, display_name: m.display_name, ...(typeof window === "number" ? { context_window: window } : {}) });
        if (out.length >= 200) break;
      }
      return out;
    } catch (e) {
      throw this.wrap(e);
    }
  }

  async getCapabilities() {
    return unknownCapabilities();
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const started = Date.now();
    try {
      const response = await this.client.messages.create(
        {
          model: req.model_id,
          max_tokens: req.max_output_tokens,
          ...(system ? { system } : {}),
          messages,
          ...(req.output_schema ? { output_config: { format: { type: "json_schema" as const, schema: req.output_schema.schema } } } : {}),
        },
        { timeout: req.timeout_ms, signal: req.signal },
      );
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const warnings: string[] = [];
      if (response.stop_reason === "refusal") warnings.push("model declined the request (stop_reason=refusal)");
      if (response.stop_reason === "max_tokens") warnings.push("output was cut off at max_tokens");
      let structured: unknown = null;
      if (req.output_schema && response.stop_reason !== "refusal") {
        try {
          structured = JSON.parse(text);
        } catch {
          warnings.push("structured output requested but the content was not valid JSON");
        }
      }
      return {
        text,
        structured,
        finish_reason: response.stop_reason ?? null,
        usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
        provider_id: this.providerId,
        model_id: response.model,
        latency_ms: Date.now() - started,
        request_id: response._request_id ?? null,
        warnings,
      };
    } catch (e) {
      throw this.wrap(e);
    }
  }

  async close() {}
}
