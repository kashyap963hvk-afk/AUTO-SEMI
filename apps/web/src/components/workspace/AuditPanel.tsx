"use client";

import React from "react";
import { api, Pill } from "../ui";
import type { PanelProps } from "./types";

interface Audit {
  events: { id: string; actor: string; action: string; detail: Record<string, unknown>; created_at: string }[];
  ai_executions: { id: string; role: string; prompt_id: string; provider_id: string | null; model_id: string | null; adapter_version: string | null; input_hash: string; output_hash: string | null; status: string; latency_ms: number | null; warnings: string[]; error: string | null; created_at: string; route: unknown }[];
}

export function AuditPanel({ ov }: PanelProps) {
  const [a, setA] = React.useState<Audit | null>(null);
  React.useEffect(() => {
    api<Audit>(`/api/projects/${ov.project.id}/audit`).then(setA).catch(() => {});
  }, [ov.project.id, ov.project.updated_at]);
  if (!a) return <span className="spin" />;
  return (
    <div className="stack">
      <div className="card">
        <h2>AI execution provenance</h2>
        <p className="small muted">Every AI call records provider, model, adapter and prompt version, the capability snapshot, the route decision and input/output hashes. Raw prompts are not logged.</p>
        <table>
          <thead><tr><th>When</th><th>Role · prompt</th><th>Provider / model</th><th>Status</th><th>Hashes</th></tr></thead>
          <tbody>
            {a.ai_executions.map((e) => (
              <tr key={e.id}>
                <td className="small">{new Date(e.created_at).toLocaleTimeString()}</td>
                <td className="small">{e.role}<div className="faint mono">{e.prompt_id}</div></td>
                <td className="small">{e.provider_id ?? "–"}<div className="faint mono">{e.model_id} · {e.adapter_version}</div></td>
                <td><Pill tone={e.status === "accepted_as_proposal" ? "good" : e.status === "blocked" ? "warn" : "bad"}>{e.status}</Pill>{e.error && <div className="small faint">{e.error}</div>}</td>
                <td className="mono small faint">in {e.input_hash.slice(0, 12)}…<br />out {e.output_hash?.slice(0, 12) ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Audit trail</h2>
        <table>
          <tbody>
            {a.events.map((e) => (
              <tr key={e.id}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{new Date(e.created_at).toLocaleString()}</td>
                <td className="mono small">{e.action}</td>
                <td className="mono small faint" style={{ wordBreak: "break-all" }}>{JSON.stringify(e.detail).slice(0, 220)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
