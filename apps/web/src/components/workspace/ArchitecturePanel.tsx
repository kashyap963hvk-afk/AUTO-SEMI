"use client";

import React from "react";
import { api, Pill } from "../ui";
import type { Architecture } from "@/lib/domain/architecture";
import type { PanelProps } from "./types";

function BlockDiagram({ arch }: { arch: Architecture }) {
  const W = arch.parameters.find((x) => x.name === "WIDTH")?.value;
  const D = arch.parameters.find((x) => x.name === "DEPTH")?.value;
  const box = (x: number, y: number, w: number, h: number, title: string, sub: string, color: string) => (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={12} fill="#0f1522" stroke={color} strokeWidth={1.6} />
      <text x={x + w / 2} y={y + h / 2 - 4} textAnchor="middle" fill="#e6ecf5" fontSize={14} fontWeight={700}>{title}</text>
      <text x={x + w / 2} y={y + h / 2 + 15} textAnchor="middle" fill="#93a1b8" fontSize={11.5}>{sub}</text>
    </g>
  );
  const arrow = (x1: number, y1: number, x2: number, y2: number, label: string, lx?: number, ly?: number) => (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#5eead4" strokeWidth={1.6} markerEnd="url(#arr)" />
      <text x={lx ?? (x1 + x2) / 2} y={ly ?? (y1 + y2) / 2 - 6} textAnchor="middle" fill="#93a1b8" fontSize={11} fontFamily="JetBrains Mono, monospace">{label}</text>
    </g>
  );
  return (
    <svg viewBox="0 0 860 330" className="diagram" role="img" aria-label={`Block diagram: write control and read control around a ${D} by ${W} bit storage array, with an occupancy counter producing full, empty and count.`}>
      <defs>
        <marker id="arr" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#5eead4" />
        </marker>
      </defs>
      <rect x={150} y={20} width={560} height={290} rx={18} fill="none" stroke="#2f3f5e" strokeDasharray="6 6" />
      <text x={166} y={42} fill="#66748c" fontSize={12} fontFamily="JetBrains Mono, monospace">sync_fifo</text>
      {arrow(20, 110, 180, 110, `wr_en, wr_data[${W}]`, 90, 100)}
      {arrow(690, 110, 840, 110, `rd_data[${W}]`, 770, 100)}
      {arrow(840, 150, 690, 150, "rd_en", 770, 166)}
      {box(180, 70, 150, 80, "Write control", "wr_ptr", "#818cf8")}
      {box(355, 60, 150, 100, "Storage", `${D} × ${W} bits (flip-flops)`, "#5eead4")}
      {box(530, 70, 160, 80, "Read control", "rd_ptr · fall-through read", "#818cf8")}
      {box(355, 210, 150, 80, "Occupancy", "count register", "#fbbf24")}
      {arrow(330, 110, 355, 110, "")}
      {arrow(505, 110, 530, 110, "")}
      {arrow(255, 150, 380, 215, "accepted", 300, 195)}
      {arrow(610, 150, 480, 215, "accepted", 565, 195)}
      {arrow(505, 260, 840, 260, "full, empty, count", 700, 250)}
      {arrow(20, 290, 180, 290, "clk, reset", 90, 280)}
    </svg>
  );
}

export function ArchitecturePanel({ ov, reload, toast, go }: PanelProps) {
  const p = ov.project;
  const [row, setRow] = React.useState<{ revision: number; content: Architecture; content_hash: string; approval: unknown } | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!p.data.architecture_revision) return;
    api<typeof row>(`/api/projects/${p.id}/architecture`).then(setRow).catch((e) => toast(e.message));
  }, [p.id, p.data.architecture_revision, toast]);

  async function act(path: string, json: unknown, after?: string) {
    setBusy(true);
    try {
      await api(`/api/projects/${p.id}/architecture/${path}`, { json });
      await reload();
      if (after) go(after);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!p.data.spec_approved_revision) {
    return <div className="card"><h2>Architecture</h2><p className="muted">Approve the specification first.</p></div>;
  }
  if (!row || !p.data.architecture_revision) {
    return (
      <div className="card">
        <h2>Architecture proposal</h2>
        <p className="muted">Generate a block diagram, interface contract, design decisions and risk list from the approved specification.</p>
        <button className="btn primary" disabled={busy || p.state !== "SPEC_APPROVED"} onClick={() => act("generate", {})}>
          {busy ? <span className="spin" /> : null} Propose architecture
        </button>
      </div>
    );
  }
  const a = row.content;
  const waiting = p.state === "ARCHITECTURE_REVIEW_REQUIRED";
  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">
          <div>
            <h2>Architecture proposal</h2>
            <span className="small muted">Revision {row.revision} · from spec revision {a.spec_revision} · template {a.template}</span>
          </div>
          {row.approval ? <Pill tone="good">Approved</Pill> : <Pill tone="warn">Waiting for approval</Pill>}
        </div>
        <BlockDiagram arch={a} />
        <p className="small muted" style={{ marginTop: 8 }}>{a.clock_reset} Storage estimate: {a.estimates.storage_bits} bits ({a.estimates.note})</p>
      </div>
      <div className="grid two">
        <div className="card">
          <h3>Decisions for your review</h3>
          {a.decisions.map((d) => (
            <div key={d.id} style={{ marginBottom: 12 }}>
              <div className="row"><span className="mono small faint">{d.id}</span><b>{d.decision}</b>{d.needs_approval && <Pill tone="warn">needs approval</Pill>}</div>
              <div className="small">Chosen: {d.chosen}</div>
              <div className="small muted">Alternative kept on record: {d.alternatives.join("; ")}</div>
              <div className="small faint">{d.rationale}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Risks</h3>
          <table>
            <tbody>
              {a.risks.map((r) => (
                <tr key={r.risk}>
                  <td><Pill tone="info">{r.area}</Pill></td>
                  <td className="small">{r.risk}<div className="faint">{r.mitigation}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 style={{ marginTop: 14 }}>Verification strategy</h3>
          <ul className="small muted">{a.verification_strategy.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
      </div>
      {waiting && (
        <div className="card row between">
          <span className="muted">Approving locks this architecture. RTL is then generated from it as an immutable, hashed revision.</span>
          <button className="btn primary" disabled={busy} onClick={() => act("approve", { revision: row.revision }, "design")}>
            {busy ? <span className="spin" /> : null} Approve architecture
          </button>
        </div>
      )}
    </div>
  );
}
