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

      <StageCard stage="physical" run={ov.latestRuns.physical} current={p.data.source_revision} live={busy ? "running" : "idle"} />
      {ov.latestRuns.physical && !busy && <PhysicalEvidence run={ov.latestRuns.physical} />}
    </div>
  );
}

const CHECK_LABEL: Record<string, string> = {
  flow: "RTL→GDSII flow completed",
  sta_setup: "Setup timing (STA)",
  sta_hold: "Hold timing (STA)",
  electrical_rules: "Max slew / cap / fanout",
  route_drc: "Router DRC",
  antenna: "Antenna rules",
  klayout_drc: "KLayout DRC (whole deck)",
  klayout_drc_feol: "KLayout DRC: front-end rules (FEOL)",
  lvs: "LVS (layout vs netlist)",
  equivalence_check: "Logic equivalence (final netlist vs RTL)",
  multi_corner_sta: "Multi-corner STA (ss/ff)",
};

function PhysicalEvidence({ run }: { run: { id: string; result: import("@/lib/eda/contracts").StageResult } }) {
  const m = run.result.metrics as Record<string, unknown> & { checks?: Record<string, string> };
  if (!m.checks) return null;
  const img = run.result.artifacts.find((a) => a.path.endsWith("final_routing.webp"));
  const gds = run.result.artifacts.find((a) => a.path.endsWith(".gds"));
  const num = (k: string, d = 2) => (typeof m[k] === "number" ? (m[k] as number).toFixed(d) : "–");
  return (
    <div className="grid two">
      <div className="card">
        <h3>Sign-off checks (as run)</h3>
        <table>
          <tbody>
            {Object.entries(m.checks).map(([k, v]) => (
              <tr key={k}>
                <td>{CHECK_LABEL[k] ?? k}</td>
                <td style={{ textAlign: "right" }}><Pill tone={v === "PASS" ? "good" : v === "NOT_RUN" ? "warn" : "bad"}>{v.replace("_", " ")}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid three" style={{ marginTop: 12 }}>
          <div className="metric"><b>{num("worst_slack_ns")} ns</b><span>worst setup slack @ {String(m.clock_period_ns)} ns</span></div>
          <div className="metric"><b>{num("wns_ns")} / {num("tns_ns")}</b><span>WNS / TNS (ns)</span></div>
          <div className="metric"><b>{num("critical_path_delay_ns")} ns</b><span>critical path delay</span></div>
          <div className="metric"><b>{typeof m.design_area_um2 === "number" ? Math.round(m.design_area_um2 as number).toLocaleString() : "–"} µm²</b><span>cell area · {String(m.utilization_pct ?? "–")}% util</span></div>
          <div className="metric"><b>{typeof m.power_total_w === "number" ? ((m.power_total_w as number) * 1000).toFixed(1) : "–"} mW</b><span>power (vectorless, tt)</span></div>
          <div className="metric"><b>{typeof m.worst_ir_drop_v === "number" ? ((m.worst_ir_drop_v as number) * 1000).toFixed(1) : "–"} mV</b><span>worst IR drop</span></div>
        </div>
        <p className="small faint" style={{ marginTop: 10 }}>
          DRC scope: {String(m.klayout_drc_scope ?? "–")}. {String(m.klayout_drc_violations ?? "–")} KLayout DRC markers, {String(m.route_drc_violations ?? "–")} router DRC, LVS {String(m.lvs ?? "–")}.
        </p>
        {gds && (
          <a className="btn small" href={`/api/runs/${run.id}/artifacts?path=${encodeURIComponent(gds.path)}`}>
            ⬇ Download GDSII ({(gds.size / 1e6).toFixed(1)} MB · sha256 {gds.sha256.slice(0, 10)}…)
          </a>
        )}
      </div>
      <div className="card">
        <h3>Routed layout (OpenROAD)</h3>
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/runs/${run.id}/artifacts?path=${encodeURIComponent(img.path)}`} alt="Routed layout of the FIFO: power grid, standard-cell rows and signal routing on SKY130" style={{ width: "100%", borderRadius: 10, border: "1px solid var(--line)" }} />
        ) : (
          <p className="muted">No layout image was produced.</p>
        )}
      </div>
    </div>
  );
}
