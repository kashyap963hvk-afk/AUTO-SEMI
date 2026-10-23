"use client";

import React from "react";
import { api, CodeView, Pill, SourceBadge, statusTone } from "../ui";
import { QUESTION_BY_KEY } from "@/lib/domain/fifo";
import type { DesignSpec } from "@/lib/domain/spec";
import type { PanelProps } from "./types";

interface SpecRow {
  revision: number;
  spec: DesignSpec;
  spec_hash: string;
  yaml: string;
  approval: { approved_by: string; approved_at: string; accepted: string[] } | null;
  revisions: { revision: number; spec_hash: string; approval: unknown }[];
}

export function SpecReview({ ov, reload, toast, go }: PanelProps) {
  const p = ov.project;
  const [row, setRow] = React.useState<SpecRow | null>(null);
  const [accepted, setAccepted] = React.useState<string[]>([]);
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!p.data.spec_revision) return;
    api<SpecRow>(`/api/projects/${p.id}/specification`).then(setRow).catch((e) => toast(e.message));
  }, [p.id, p.data.spec_revision, toast]);

  if (!p.data.spec_revision || !row) {
    return (
      <div className="card">
        <h2>Specification</h2>
        <p className="muted">Answer the discovery questions first, then generate a specification for review.</p>
        <button className="btn" onClick={() => go("discovery")}>Go to discovery</button>
      </div>
    );
  }

  const spec = row.spec;
  const reviewing = p.state === "SPEC_REVIEW_REQUIRED";
  const proposals = ov.approval.proposalsNeedingAcceptance;
  const allAccepted = proposals.every((k) => accepted.includes(k));

  async function approve() {
    setBusy(true);
    try {
      await api(`/api/projects/${p.id}/specification/approve`, { json: { revision: p.data.spec_revision, accepted, acknowledge_physical_unknowns: ack } });
      await reload();
      toast("Specification approved. Requirements are now locked for this revision.", "good");
      go("architecture");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">
          <div>
            <h2>Review and approve the specification</h2>
            <span className="small muted">
              Revision {row.revision} · sha256 <span className="mono">{row.spec_hash.slice(0, 16)}…</span>
            </span>
          </div>
          {row.approval ? <Pill tone="good">Approved {new Date(row.approval.approved_at).toLocaleString()}</Pill> : <Pill tone="warn">Waiting for your approval</Pill>}
        </div>
        <p style={{ fontSize: 16 }}>
          A first-in, first-out buffer holding up to <b>{String(spec.parameters.DEPTH)}</b> values of <b>{String(spec.parameters.WIDTH)} bits</b>. Values come out in the order they went in. The block reports <i>full</i>, <i>empty</i> and the number of stored values.
        </p>
        <table>
          <thead>
            <tr>
              <th>Requirement</th>
              <th>Value</th>
              <th>Source</th>
              <th>Why / where it came from</th>
              {reviewing && <th>Accept</th>}
            </tr>
          </thead>
          <tbody>
            {spec.fields.map((f) => {
              const q = QUESTION_BY_KEY[f.key as keyof typeof QUESTION_BY_KEY];
              const needs = proposals.includes(f.key);
              return (
                <tr key={f.key}>
                  <td><b>{q?.label ?? f.key}</b></td>
                  <td>{f.value === null ? <span className="faint">unknown</span> : `${String(f.value)}${f.unit ? ` ${f.unit}` : ""}`}</td>
                  <td><SourceBadge source={f.source} status={f.status} /></td>
                  <td className="small muted">{f.rationale}</td>
                  {reviewing && (
                    <td>
                      {needs ? (
                        <label className="check">
                          <input type="checkbox" checked={accepted.includes(f.key)} onChange={(e) => setAccepted((a) => (e.target.checked ? [...a, f.key] : a.filter((k) => k !== f.key)))} />
                          <span className="small">Accept proposal</span>
                        </label>
                      ) : (
                        <span className="faint small">–</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid two">
        <div className="card">
          <h3>Testable requirements</h3>
          <table>
            <tbody>
              {spec.requirements.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.id}</td>
                  <td>
                    <b>{r.title}</b>
                    <div className="small muted">{r.statement}</div>
                    <div className="small faint">Verified by: {r.verification_method.join(", ")}</div>
                  </td>
                  <td><Pill tone={statusTone(r.status === "confirmed" ? "PASS" : r.status === "unknown" ? "missing" : "waiting")}>{r.status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="stack">
          <div className="card">
            <h3>Interface (pins)</h3>
            <table>
              <tbody>
                {spec.interfaces.map((port) => (
                  <tr key={port.name}>
                    <td className="mono">{port.name}</td>
                    <td className="small muted">{port.direction}</td>
                    <td className="mono small">[{port.width}]</td>
                    <td className="small">{port.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>Open questions & out of scope</h3>
            {spec.open_questions.length === 0 ? <p className="small muted">No open questions.</p> : spec.open_questions.map((q) => (
              <div key={q.field} className="notice warn small" style={{ marginBottom: 8 }}>
                <b>{QUESTION_BY_KEY[q.field as keyof typeof QUESTION_BY_KEY]?.label}</b> is unknown. Blocks: {q.blocks.join(", ")}.
              </div>
            ))}
            <ul className="small muted">
              {spec.out_of_scope.map((o) => <li key={o}>{o}</li>)}
            </ul>
          </div>
        </div>
      </div>

      {reviewing && (
        <div className="card">
          <h3>Approve</h3>
          {ov.approval.blockers.filter((b) => !b.includes("not accepted")).length > 0 && (
            <div className="notice bad" style={{ marginBottom: 10 }}>
              Cannot approve yet: {ov.approval.blockers.filter((b) => !b.includes("not accepted")).join("; ")}.{" "}
              <button className="btn small" onClick={() => go("discovery")}>Answer in discovery</button>
            </div>
          )}
          {ov.approval.physicalUnknowns.length > 0 && (
            <label className="check" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>
                I understand that <b>{ov.approval.physicalUnknowns.map((k) => QUESTION_BY_KEY[k as keyof typeof QUESTION_BY_KEY]?.label).join(" and ")}</b> stay open. RTL work can continue, but layout and timing stay blocked until they are resolved.
              </span>
            </label>
          )}
          <div className="row">
            <button className="btn primary" disabled={busy || !allAccepted || (ov.approval.physicalUnknowns.length > 0 && !ack)} onClick={approve}>
              {busy ? <span className="spin" /> : null} Approve specification
            </button>
            {!allAccepted && <span className="small muted">Accept each AI proposal above, or change it in discovery.</span>}
          </div>
        </div>
      )}

      <div className="card">
        <details>
          <summary>design_spec.yaml (revision {row.revision})</summary>
          <CodeView text={row.yaml} maxHeight={420} />
        </details>
      </div>
    </div>
  );
}
