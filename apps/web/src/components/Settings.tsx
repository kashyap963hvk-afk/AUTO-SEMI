"use client";

import React from "react";
import { api, Pill, statusTone, useToast } from "./ui";

interface Provider {
  id: string;
  display_name: string;
  adapter: string;
  endpoint: string | null;
  connection_class: string;
  connection_label: string;
  topology: string;
  api_key_env: string | null;
  api_key_configured: boolean | null;
  last_probe: { ok: boolean; detail: string; at: string } | null;
}
interface Profile {
  id: string;
  provider_id: string;
  model_id: string;
  capabilities: Record<string, string>;
  conformance: { at: string; tests: { id: string; title: string; status: string; detail: string }[] } | null;
}
interface SystemInfo {
  database: { kind: string; ephemeral: boolean };
  eda: { worker: string; recorded_evidence_results: number; in_process_wasm: string[]; physical: string };
  notes: string[];
}

export function Settings() {
  const [sys, setSys] = React.useState<SystemInfo | null>(null);
  const [providers, setProviders] = React.useState<Provider[]>([]);
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [form, setForm] = React.useState({ display_name: "", adapter: "openai_compatible", endpoint: "", connection_class: "local_private", topology: "same_machine", api_key_env: "" });
  const [modelIds, setModelIds] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [toast, show] = useToast();

  const load = React.useCallback(async () => {
    api<SystemInfo>("/api/system").then(setSys).catch(() => {});
    api<Provider[]>("/api/ai/providers").then(setProviders).catch(() => {});
    api<Profile[]>("/api/ai/models").then(setProfiles).catch(() => {});
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      if (ok) show(ok, "good");
      await load();
    } catch (e) {
      show((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <h1>Tools &amp; AI</h1>
      {sys && (
        <div className="grid two">
          <div className="card">
            <h3>EDA toolchain</h3>
            <dl className="kv">
              <dt>EDA worker</dt><dd><Pill tone={sys.eda.worker === "configured" ? "good" : "warn"}>{sys.eda.worker}</Pill></dd>
              <dt>Recorded real runs</dt><dd>{sys.eda.recorded_evidence_results} results (Verilator 5.020, cocotb 2.1 + Icarus 12, SymbiYosys + z3, Yosys 0.33)</dd>
              <dt>In-process</dt><dd>{sys.eda.in_process_wasm.join(", ") || "disabled"}</dd>
              <dt>Physical</dt><dd>{sys.eda.physical}</dd>
              <dt>UVM</dt><dd>Not supported on the cocotb + Icarus path. Needs a capability-tested simulator adapter.</dd>
            </dl>
          </div>
          <div className="card">
            <h3>Storage</h3>
            <dl className="kv">
              <dt>Database</dt><dd>{sys.database.kind} {sys.database.ephemeral ? <Pill tone="warn">ephemeral</Pill> : <Pill tone="good">persistent</Pill>}</dd>
            </dl>
            <ul className="small muted">{sys.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        </div>
      )}

      <div className="card">
        <h2>AI model connections</h2>
        <p className="small muted">
          Any reachable model works through an adapter: an OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM, hosted gateways), a native provider adapter, or the built-in deterministic engine. A chat-website subscription is not an API and cannot be connected. Keys are never stored. You name an environment variable (DEVIN_AI_…) that holds the key on the server.
        </p>
        <table>
          <thead><tr><th>Provider</th><th>Connection</th><th>Health</th><th>Models / conformance</th></tr></thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td>
                  <b>{p.display_name}</b>
                  <div className="small faint mono">{p.adapter}{p.endpoint ? ` · ${p.endpoint}` : ""}</div>
                  {p.api_key_env && <div className="small faint">key: <span className="mono">{p.api_key_env}</span> {p.api_key_configured ? "(set)" : "(not set on server)"}</div>}
                </td>
                <td><Pill tone={p.connection_class === "third_party_hosted" ? "warn" : "good"}>{p.connection_label}</Pill><div className="small faint">{p.topology.replace(/_/g, " ")}</div></td>
                <td>
                  {p.last_probe ? <Pill tone={p.last_probe.ok ? "good" : "bad"}>{p.last_probe.ok ? "healthy" : "failed"}</Pill> : <Pill>not probed</Pill>}
                  {p.last_probe && <div className="small faint">{p.last_probe.detail}</div>}
                  {p.id !== "builtin-mock" && <button className="btn small ghost" disabled={busy === p.id} onClick={() => run(p.id, () => api(`/api/ai/providers/${p.id}/probe`, { method: "POST" }))}>Test connection</button>}
                </td>
                <td style={{ minWidth: 320 }}>
                  {profiles.filter((m) => m.provider_id === p.id).map((m) => (
                    <div key={m.id} style={{ marginBottom: 8 }}>
                      <span className="mono small">{m.model_id}</span>{" "}
                      {Object.entries(m.capabilities).filter(([, v]) => v !== "unknown").map(([k, v]) => <Pill key={k} tone={v === "verified" ? "good" : "neutral"}>{k}: {v}</Pill>)}
                      {m.conformance && (
                        <details>
                          <summary>Conformance results ({new Date(m.conformance.at).toLocaleString()})</summary>
                          {m.conformance.tests.map((t) => <div key={t.id} className="small"><Pill tone={statusTone(t.status === "pass" ? "PASS" : t.status === "not_run" ? "NOT_RUN" : "FAIL")}>{t.status}</Pill> {t.title}: <span className="faint">{t.detail}</span></div>)}
                        </details>
                      )}
                    </div>
                  ))}
                  {p.id !== "builtin-mock" && (
                    <div className="row">
                      <input type="text" placeholder="model ID, e.g. as listed by the endpoint" value={modelIds[p.id] ?? ""} onChange={(e) => setModelIds({ ...modelIds, [p.id]: e.target.value })} style={{ maxWidth: 240 }} />
                      <button className="btn small" disabled={!modelIds[p.id] || busy === `c${p.id}`} onClick={() => run(`c${p.id}`, () => api(`/api/ai/providers/${p.id}/conformance-tests`, { json: { model_id: modelIds[p.id] } }), "Conformance tests finished.")}>
                        {busy === `c${p.id}` ? <span className="spin" /> : null} Run conformance tests
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Add a connection</h3>
        <div className="grid three">
          <div>
            <label className="field-label">Name</label>
            <input type="text" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="My local model" />
          </div>
          <div>
            <label className="field-label">Adapter</label>
            <select value={form.adapter} onChange={(e) => setForm({ ...form, adapter: e.target.value, ...(e.target.value === "anthropic" ? { connection_class: "third_party_hosted", topology: "public_internet" } : {}) })}>
              <option value="openai_compatible">OpenAI-compatible endpoint</option>
              <option value="anthropic">Anthropic (native Messages API)</option>
            </select>
          </div>
          <div>
            <label className="field-label">API key environment variable</label>
            <input type="text" value={form.api_key_env} onChange={(e) => setForm({ ...form, api_key_env: e.target.value.toUpperCase() })} placeholder="DEVIN_AI_LOCAL_KEY (optional for local)" />
          </div>
          {form.adapter === "openai_compatible" && (
            <>
              <div>
                <label className="field-label">Base URL</label>
                <input type="text" value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="http://10.0.0.5:8000/v1" />
              </div>
              <div>
                <label className="field-label">Connection type</label>
                <select value={form.connection_class} onChange={(e) => setForm({ ...form, connection_class: e.target.value })}>
                  <option value="local_private">Local / private endpoint</option>
                  <option value="self_hosted_gateway">Self-hosted gateway (e.g. LiteLLM)</option>
                  <option value="third_party_hosted">Third-party hosted API</option>
                </select>
              </div>
              <div>
                <label className="field-label">Network topology</label>
                <select value={form.topology} onChange={(e) => setForm({ ...form, topology: e.target.value })}>
                  <option value="same_machine">Same machine as this app</option>
                  <option value="docker_network">Docker network</option>
                  <option value="private_network">Private network</option>
                  <option value="device_connector">Device connector</option>
                  <option value="public_internet">Public internet</option>
                </select>
              </div>
            </>
          )}
        </div>
        <p className="small faint" style={{ marginTop: 8 }}>
          A hosted app cannot reach <span className="mono">localhost</span> on your laptop. Inside Docker, <span className="mono">localhost</span> is the container itself. Cloud-metadata addresses are always blocked, private addresses are allowed only for local/private connections, and redirects are never followed.
        </p>
        <button className="btn primary" disabled={!form.display_name || busy === "add"} onClick={() => run("add", () => api("/api/ai/providers", { json: { ...form, endpoint: form.adapter === "anthropic" ? null : form.endpoint, api_key_env: form.api_key_env || null } }), "Connection added. Run the conformance tests before using it.")}>
          Add connection
        </button>
      </div>
      {toast}
    </div>
  );
}
