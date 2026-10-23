"use client";

import Link from "next/link";
import React from "react";
import { api, Pill } from "../ui";
import type { ProjectAiPolicy } from "@/lib/ai/contracts";
import type { PanelProps } from "./types";

interface Profile {
  id: string;
  provider_id: string;
  model_id: string;
  capabilities: Record<string, string>;
}
interface Provider {
  id: string;
  display_name: string;
  connection_label: string;
}

const ROLES = ["requirements_analyst", "failure_analyst"];

export function AiPolicyPanel({ ov, reload, toast }: PanelProps) {
  const p = ov.project;
  const [policy, setPolicy] = React.useState<ProjectAiPolicy>(p.ai_policy);
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [providers, setProviders] = React.useState<Provider[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api<Profile[]>("/api/ai/models").then(setProfiles).catch(() => {});
    api<Provider[]>("/api/ai/providers").then(setProviders).catch(() => {});
  }, []);

  const prov = (id: string) => providers.find((x) => x.id === profiles.find((m) => m.id === id)?.provider_id);
  async function save() {
    setBusy(true);
    try {
      await api(`/api/projects/${p.id}/ai-policy`, { json: policy });
      await reload();
      toast("AI policy saved. The change is recorded in the audit trail.", "good");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const label = (id: string) => {
    const m = profiles.find((x) => x.id === id);
    const pr = prov(id);
    return m ? `${m.model_id} · ${pr?.display_name ?? m.provider_id} (${pr?.connection_label ?? ""})` : id;
  };

  return (
    <div className="stack">
      <div className="card">
        <h2>AI provider & data policy</h2>
        <p className="small muted">
          The workflow, verification policy and EDA tools do not depend on any AI vendor. Agents only propose, and the tools decide what passes. Add model connections (local, self-hosted or hosted) in <Link href="/settings">Tools &amp; AI</Link>.
        </p>
        <label className="field-label">Project data egress</label>
        <div className="grid three">
          {(
            [
              ["local_only", "Local only", "No project content may go to a third-party hosted API."],
              ["approved_providers_only", "Approved providers only", "Only providers you list below may receive project content."],
              ["user_authorized_remote", "Remote allowed (after disclosure)", "Hosted APIs may receive project content. Your authorisation is timestamped."],
            ] as const
          ).map(([k, t, d]) => (
            <label key={k} className="card tight check" style={{ borderColor: policy.data_egress === k ? "var(--accent)" : undefined }}>
              <input type="radio" checked={policy.data_egress === k} onChange={() => setPolicy({ ...policy, data_egress: k })} />
              <span><b>{t}</b><div className="small muted">{d}</div></span>
            </label>
          ))}
        </div>
        {policy.data_egress === "approved_providers_only" && (
          <div style={{ marginTop: 12 }}>
            {providers.filter((x) => x.id !== "builtin-mock").map((x) => (
              <label key={x.id} className="check small">
                <input type="checkbox" checked={policy.approved_provider_ids.includes(x.id)} onChange={(e) => setPolicy({ ...policy, approved_provider_ids: e.target.checked ? [...policy.approved_provider_ids, x.id] : policy.approved_provider_ids.filter((i) => i !== x.id) })} />
                <span>{x.display_name} ({x.connection_label})</span>
              </label>
            ))}
          </div>
        )}
        <hr />
        <div className="grid two">
          <div>
            <label className="field-label">Default model for all agent roles</label>
            <select value={policy.default_model_profile} onChange={(e) => setPolicy({ ...policy, default_model_profile: e.target.value })}>
              {profiles.map((m) => <option key={m.id} value={m.id}>{label(m.id)}</option>)}
            </select>
          </div>
          {ROLES.map((r) => (
            <div key={r}>
              <label className="field-label">Override: {r}</label>
              <select value={policy.agent_routing[r] ?? ""} onChange={(e) => setPolicy({ ...policy, agent_routing: { ...policy.agent_routing, [r]: e.target.value || undefined } })}>
                <option value="">(use default)</option>
                {profiles.map((m) => <option key={m.id} value={m.id}>{label(m.id)}</option>)}
              </select>
            </div>
          ))}
        </div>
        <label className="check small" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={policy.allow_automatic_remote_fallback} onChange={(e) => setPolicy({ ...policy, allow_automatic_remote_fallback: e.target.checked })} />
          <span>Allow automatic fallback to another model when the primary fails. The fallback must still pass the data policy and capability checks, and every route is recorded.</span>
        </label>
        {policy.allow_automatic_remote_fallback && (
          <select value={policy.fallback_model_profile ?? ""} onChange={(e) => setPolicy({ ...policy, fallback_model_profile: e.target.value || null })} style={{ marginTop: 8 }}>
            <option value="">(choose fallback)</option>
            {profiles.map((m) => <option key={m.id} value={m.id}>{label(m.id)}</option>)}
          </select>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy} onClick={save}>Save policy</button>
          {policy.data_egress === "local_only" && <Pill tone="good">A local model failure can never trigger a remote call</Pill>}
        </div>
      </div>
    </div>
  );
}
