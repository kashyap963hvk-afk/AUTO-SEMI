"use client";

import React from "react";
import { api, CodeView, Pill } from "../ui";
import { StageCard } from "./StageCard";
import type { PanelProps } from "./types";

const STEPS = ["Platform preflight", "Floorplan & I/O", "Tapcells & PDN", "Global/detailed placement", "Clock-tree synthesis", "Global/detailed routing", "Antenna & parasitics", "Post-route STA", "DRC / LVS", "GDSII export"];

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function PhysicalPanel({ ov, reload, toast }: PanelProps) {
  const p = ov.project;
  const [sdc, setSdc] = React.useState<string | null>(null);
  const [approver, setApprover] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const clock = p.data.fields.find((f) => f.key === "clock_mhz");
  const pdk = p.data.fields.find((f) => f.key === "target_pdk");

  React.useEffect(() => {
    if (!p.data.source_revision) return;
    api<{ files: Record<string, string> }>(`/api/projects/${p.id}/rtl`).then((r) => setSdc(r.files["constraints/approved.sdc"] ?? null)).catch(() => {});
  }, [p.id, p.data.source_revision]);

  async function approve() {
    if (!sdc) return;
    setBusy(true);
    try {
      await api(`/api/projects/${p.id}/constraints/approve`, { json: { sdc_sha256: await sha256Hex(sdc), approver_name: approver } });
      await reload();
      toast("Timing constraints approved and bound to this SDC's SHA-256.", "good");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    try {
      await api(`/api/projects/${p.id}/runs/physical-design`, { method: "POST" });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      await reload();
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">
          <div>
            <h2>Physical Design Center</h2>
            <span className="small muted">Primary flow: OpenROAD Flow Scripts (RTL→GDSII) on one confirmed public PDK.</span>
          </div>
          <button className="btn primary" disabled={busy || !p.data.source_revision} onClick={run}>
            {busy ? <span className="spin" /> : "▶"} Run physical design
          </button>
        </div>
        <div className="grid three">
          <div className="metric"><b>{clock?.status === "confirmed" ? `${clock.value} MHz` : "Unknown"}</b><span>clock (REQ-CLK-001)</span></div>
          <div className="metric"><b>{pdk?.status === "confirmed" && pdk.value !== "undecided" ? String(pdk.value) : "Unconfirmed"}</b><span>target PDK</span></div>
          <div className="metric"><b>{p.data.constraints ? "Approved" : sdc ? "Draft" : "Missing"}</b><span>timing constraints (SDC)</span></div>
        </div>
        <div className="row" style={{ marginTop: 14, gap: 6 }}>
          {STEPS.map((s) => <Pill key={s} tone="neutral">{s}</Pill>)}
        </div>
        <p className="small faint" style={{ marginTop: 10 }}>
          Public SKY130 and GF180MCU releases are published as experimental previews. A DRC/LVS pass with public decks is a prototype check, not foundry sign-off.
        </p>
      </div>

      <div className="card">
        <h3>Timing constraints</h3>
        {!sdc ? (
          <div className="notice warn">TIMING_CONSTRAINTS_INCOMPLETE: the clock frequency is not confirmed, so no SDC can be drafted. Layout and timing stay blocked.</div>
        ) : (
          <>
            <p className="small muted">A draft generated from your approved clock. The I/O delay budget and uncertainty are proposals. A qualified person must approve them before any timing result counts.</p>
            <CodeView text={sdc} maxHeight={240} />
            {p.data.constraints ? (
              <div className="notice good small" style={{ marginTop: 10 }}>
                Approved by {p.data.constraints.approved_by} at {new Date(p.data.constraints.approved_at).toLocaleString()} · sha256 <span className="mono">{p.data.constraints.sdc_sha256.slice(0, 16)}…</span>
              </div>
            ) : (
              <div className="row" style={{ marginTop: 10 }}>
                <input type="text" placeholder="Approver name" value={approver} onChange={(e) => setApprover(e.target.value)} style={{ maxWidth: 260 }} />
                <button className="btn" disabled={busy || !approver.trim()} onClick={approve}>Approve these constraints</button>
              </div>
            )}
          </>
        )}
      </div>

      <StageCard stage="physical" run={ov.latestRuns.physical} current={p.data.source_revision} live="idle" />
    </div>
  );
}
