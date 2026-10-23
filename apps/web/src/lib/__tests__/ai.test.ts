import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DEVIN_DB = "memory";
process.env.DEVIN_MIGRATIONS_DIR = path.resolve(__dirname, "../../../migrations");

import { checkEndpoint, classifyIp } from "../ai/endpointSafety";
import { mockExtract } from "../ai/adapters/mock";
import { egressDecision } from "../ai/policy";
import { defaultAiPolicy } from "../ai/contracts";
import { BUILTIN_PROVIDER, createProvider, createProfile, instantiate, saveConformance, setResolverForTests, type ProviderRecord } from "../ai/registry";
import { runConformance } from "../ai/conformance";
import { AgentBlockedError, runAgentTask } from "../ai/agentRuntime";
import { getDb, resetDbForTests } from "../store/db";
import type { ReqExtractOutput } from "../ai/prompts";

/** A tiny local OpenAI-compatible endpoint standing in for vLLM/Ollama/LiteLLM. */
let server: Server;
let base = "";
let mode: "good" | "bad-json" | "down" = "good";
beforeAll(async () => {
  server = createServer((req, res) => {
    if (mode === "down") {
      res.statusCode = 503;
      return res.end("{}");
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "test-local-model" }] }));
      if (req.url === "/v1/chat/completions") {
        const body = JSON.parse(raw);
        const user = body.messages.at(-1).content as string;
        let content = "OK";
        if (body.response_format?.json_schema?.name === "conformance_answer") content = mode === "bad-json" ? "five" : '{"answer": 5}';
        if (body.response_format?.json_schema?.name === "requirements_extraction") {
          const desc = user.replace(/^<data>\n|\n<\/data>$/g, "");
          // A model that also invents an unsupported value, to prove the quote check drops it.
          content = JSON.stringify({ design_kind: "fifo", fields: [{ key: "depth", value: "16", quote: desc.match(/16 \w+/)?.[0] ?? "16" }, { key: "clock_mhz", value: "200", quote: "200 MHz" }], notes: [] });
        }
        return res.end(JSON.stringify({ id: "cmpl-1", model: body.model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());
beforeEach(async () => {
  resetDbForTests();
  mode = "good";
  setResolverForTests(undefined);
  const db = await getDb();
  await db.query("INSERT INTO users (id, token_hash, display_name) VALUES ('u1','h1','U1'), ('u2','h2','U2')");
  await db.query("INSERT INTO projects (id, owner_id, name, description, state, data, ai_policy) VALUES ('p1','u1','n','d','DRAFT','{}'::jsonb,'{}'::jsonb)");
});

describe("endpoint safety (acceptance test 26)", () => {
  it("classifies addresses", () => {
    expect(classifyIp("169.254.169.254")).toBe("metadata");
    expect(classifyIp("10.1.2.3")).toBe("private");
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("::ffff:169.254.169.254")).toBe("metadata");
    expect(classifyIp("fd00:ec2::254")).toBe("metadata");
    expect(classifyIp("8.8.8.8")).toBe("public");
  });
  it("blocks metadata targets, unsafe protocols and embedded credentials", async () => {
    expect((await checkEndpoint("http://169.254.169.254/latest", "local_private")).ok).toBe(false);
    expect((await checkEndpoint("http://metadata.google.internal/", "local_private")).ok).toBe(false);
    expect((await checkEndpoint("file:///etc/passwd", "local_private")).ok).toBe(false);
    expect((await checkEndpoint("https://u:p@example.com/v1", "third_party_hosted")).ok).toBe(false);
    expect((await checkEndpoint("http://example.com/v1", "third_party_hosted", async () => ["93.184.216.34"])).ok).toBe(false);
  });
  it("allows private targets only in explicit local/private mode, and re-checks DNS", async () => {
    expect((await checkEndpoint("http://127.0.0.1:11434/v1", "third_party_hosted")).ok).toBe(false);
    expect((await checkEndpoint("http://127.0.0.1:11434/v1", "local_private")).ok).toBe(true);
    // DNS rebinding: a public-looking name that resolves to metadata is refused.
    expect((await checkEndpoint("https://evil.example/v1", "third_party_hosted", async () => ["169.254.169.254"])).ok).toBe(false);
    expect((await checkEndpoint("https://evil.example/v1", "third_party_hosted", async () => ["10.0.0.5"])).ok).toBe(false);
  });
});

describe("data egress policy (acceptance test 22)", () => {
  const remote: ProviderRecord = { ...BUILTIN_PROVIDER, id: "r", connection_class: "third_party_hosted", adapter: "anthropic" };
  const local: ProviderRecord = { ...BUILTIN_PROVIDER, id: "l", connection_class: "local_private", adapter: "openai_compatible" };
  it("local_only refuses third-party hosted providers and allows local ones", () => {
    const p = defaultAiPolicy();
    expect(egressDecision(p, remote).allowed).toBe(false);
    expect(egressDecision(p, local).allowed).toBe(true);
    expect(egressDecision(p, BUILTIN_PROVIDER).allowed).toBe(true);
  });
  it("approved_providers_only and user_authorized_remote behave as documented", () => {
    expect(egressDecision({ ...defaultAiPolicy(), data_egress: "approved_providers_only" }, remote).allowed).toBe(false);
    expect(egressDecision({ ...defaultAiPolicy(), data_egress: "approved_providers_only", approved_provider_ids: ["r"] }, remote).allowed).toBe(true);
    expect(egressDecision({ ...defaultAiPolicy(), data_egress: "user_authorized_remote" }, remote).allowed).toBe(false);
    expect(egressDecision({ ...defaultAiPolicy(), data_egress: "user_authorized_remote", remote_authorized_at: "2026-10-23T00:00:00Z" }, remote).allowed).toBe(true);
  });
});

describe("mock requirements analyst", () => {
  it("extracts only stated values, each with a verbatim quote", () => {
    const out = mockExtract("I need a FIFO buffer that holds 16 bytes for a UART receiver at 50 MHz on SKY130 for a class project.");
    const map = Object.fromEntries(out.fields.map((f) => [f.key, f.value]));
    expect(out.design_kind).toBe("fifo");
    expect(map).toEqual({ data_width: "8", depth: "16", clock_mhz: "50", target_pdk: "sky130hd", intended_use: "prototype" });
    expect(map.reset_style).toBeUndefined();
  });
  it("flags contradictory values instead of silently picking one", () => {
    const out = mockExtract("Make it 16 entries deep, actually no, 32 entries, each 8 bits.");
    expect(out.fields.find((f) => f.key === "depth")?.value).toBe("16");
    expect(out.notes.join(" ")).toMatch(/conflicting values for depth \(16 vs 32\)/);
  });
});

async function localProvider() {
  setResolverForTests(async () => ["127.0.0.1"]);
  const p = await createProvider("u1", { display_name: "Local test runtime", adapter: "openai_compatible", endpoint: base, connection_class: "local_private", topology: "same_machine", api_key_env: "DEVIN_AI_TEST_LOCAL_KEY" });
  const prof = await createProfile("u1", p.id, "test-local-model");
  return { p, prof };
}

describe("provider swap and local runtime (acceptance tests 19, 20, 21, 23, 24)", () => {
  const description = "A FIFO with 16 entries please.";
  const check = (out: ReqExtractOutput) => ({ output: { ...out, fields: out.fields.filter((f) => description.includes(f.quote)) }, warnings: [] });

  it("runs requirements extraction through the mock provider", async () => {
    const r = await runAgentTask<ReqExtractOutput>({ ownerId: "u1", projectId: "p1", policy: defaultAiPolicy(), role: "requirements_analyst", promptId: "req_extract", input: { description }, check });
    expect(r.mock).toBe(true);
    expect(r.output.fields.find((f) => f.key === "depth")?.value).toBe("16");
  });

  it("refuses a model whose capabilities are not verified, then works after conformance", async () => {
    const { p, prof } = await localProvider();
    const policy = { ...defaultAiPolicy(), default_model_profile: prof.id };
    await expect(runAgentTask({ ownerId: "u1", projectId: "p1", policy, role: "requirements_analyst", promptId: "req_extract", input: { description } })).rejects.toThrow(/unverified required capabilities/);
    const { capabilities, report } = await runConformance(instantiate(p), "test-local-model");
    expect(capabilities.structured_output).toBe("verified");
    expect(report.tests.find((t) => t.id === "model_id")?.status).toBe("pass");
    await saveConformance("u1", prof.id, capabilities, report);
    const r = await runAgentTask<ReqExtractOutput>({ ownerId: "u1", projectId: "p1", policy, role: "requirements_analyst", promptId: "req_extract", input: { description }, check });
    expect(r.mock).toBe(false);
    expect(r.provider.connection_class).toBe("local_private");
    // The invented "200 MHz" has no quote in the description and is dropped.
    expect(r.output.fields.map((f) => f.key)).toEqual(["depth"]);
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>("SELECT * FROM ai_executions WHERE id = $1", [r.executionId]);
    expect(rows[0].adapter_version).toBe("openai_compatible@1.0.0");
    expect(rows[0].prompt_id).toBe("req_extract@1");
    expect(rows[0].input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].capability_snapshot).toBeTruthy();
  });

  it("marks structured output unsupported when the endpoint returns non-JSON", async () => {
    const { p } = await localProvider();
    mode = "bad-json";
    const { capabilities } = await runConformance(instantiate(p), "test-local-model");
    expect(capabilities.structured_output).toBe("unsupported");
  });

  it("never falls back to a remote provider under local_only when the local model fails", async () => {
    const { p, prof } = await localProvider();
    const { capabilities, report } = await runConformance(instantiate(p), "test-local-model");
    await saveConformance("u1", prof.id, capabilities, report);
    process.env.DEVIN_AI_TEST_REMOTE_KEY = "sk-test-not-a-real-key-000000000000";
    const remote = await createProvider("u1", { display_name: "Remote", adapter: "anthropic", connection_class: "third_party_hosted", topology: "public_internet", api_key_env: "DEVIN_AI_TEST_REMOTE_KEY" });
    const remoteProfile = await createProfile("u1", remote.id, "user-configured-model");
    await saveConformance("u1", remoteProfile.id, { ...capabilities }, report);
    mode = "down";
    const policy = { ...defaultAiPolicy(), default_model_profile: prof.id, allow_automatic_remote_fallback: true, fallback_model_profile: remoteProfile.id };
    const err = await runAgentTask({ ownerId: "u1", projectId: "p1", policy, role: "requirements_analyst", promptId: "req_extract", input: { description } }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentBlockedError);
    const db = await getDb();
    const blocked = await db.query<{ route: { log: { decision: string }[] } }>("SELECT route FROM ai_executions WHERE id = $1", [err.executionId]);
    expect(JSON.stringify(blocked[0].route)).toMatch(/refused by data policy: local_only/);
  });

  it("stores only secret references, never key material (acceptance test 23)", async () => {
    process.env.DEVIN_AI_TEST_LOCAL_KEY = "sk-local-secret-value-1234567890";
    await localProvider();
    const db = await getDb();
    const dump = JSON.stringify(await db.query("SELECT * FROM ai_providers")) + JSON.stringify(await db.query("SELECT * FROM ai_executions")) + JSON.stringify(await db.query("SELECT * FROM audit_events"));
    expect(dump).not.toContain("sk-local-secret-value");
    await expect(createProvider("u1", { display_name: "x", adapter: "anthropic", connection_class: "third_party_hosted", topology: "public_internet", api_key_env: "DATABASE_URL" })).rejects.toThrow(/DEVIN_AI_/);
  });
});

describe("provider-neutral business logic (acceptance test 25)", () => {
  it("only adapter modules import vendor SDKs", () => {
    const src = path.resolve(__dirname, "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const full = path.join(dir, f);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(f) && !full.includes(`${path.sep}ai${path.sep}adapters${path.sep}`) && !full.includes("__tests__")) {
          if (/from\s+["'](@anthropic-ai\/sdk|openai)["']/.test(readFileSync(full, "utf8"))) offenders.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
