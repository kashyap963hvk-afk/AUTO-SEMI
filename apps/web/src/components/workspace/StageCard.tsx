"use client";

import React from "react";
import { CodeView, ModeBadge, Pill, statusTone } from "../ui";
import { STAGE_LABEL, STAGE_PLAIN, type Stage, type StageResult } from "@/lib/eda/contracts";

export type LiveState = "idle" | "running" | "done";

export function StageCard({
  stage,
  run,
  current,
  live,
  onExplain,
  explanation,
}: {
  stage: Stage;
  run?: { id: string; result: StageResult; source_revision: number };
  current: number | null;
  live: LiveState;
  onExplain?: (runId: string) => void;
  explanation?: { summary: string; likely_cause: string; evidence: string[]; suggested_next_step: string; affects_requirements: string[]; provider: string; mock: boolean } | null;
}) {
  const [open, setOpen] = React.useState(false);
  const r = run?.result;
  const stale = run && run.source_revision !== current;
  const status = live === "running" ? "RUNNING" : r ? r.status : "NOT_RUN";
  const cls = live === "running" ? "running" : !r || stale ? "" : r.status === "PASS" ? "pass" : r.status.startsWith("BLOCKED") ? "blocked" : "fail";
  const icon = { lint: "L", simulation: "S", formal: "F", synthesis: "Y", physical: "P" }[stage];
  const iconStyle =
    cls === "pass" ? { background: "var(--good-bg)", color: "var(--good)" } : cls === "fail" ? { background: "var(--bad-bg)", color: "var(--bad)" } : cls === "running" ? { background: "var(--run-bg)", color: "var(--run)" } : cls === "blocked" ? { background: "var(--warn-bg)", color: "var(--warn)" } : { background: "var(--panel-2)", color: "var(--muted)" };
  const tv = (r?.execution as { tool_versions?: Record<string, string | null> } | undefined)?.tool_versions;
  const synth = r?.metrics as { cells_total?: number; sequential_cells?: number; combinational_cells?: number; latches?: number; area_basis?: string } | undefined;

  return (
    <div className={`stage-card ${cls}`}>
      <div className="row">
        <div className="stage-icon" style={iconStyle}>{live === "running" ? <span className="spin" /> : icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row">
            <b>{STAGE_LABEL[stage]}</b>
            <Pill tone={live === "running" ? "run" : stale ? "warn" : statusTone(status)} dot pulse={live === "running"}>
              {live === "running" ? "Running…" : stale ? `${status} · stale (rev ${run!.source_revision})` : status === "NOT_RUN" ? "Not run" : status}
            </Pill>
            {r?.formal_status && <Pill tone={statusTone(r.formal_status)}>{r.formal_status}</Pill>}
            {r && live !== "running" && <ModeBadge mode={r.execution.mode} />}
          </div>
          <div className="small muted">{live === "running" ? STAGE_PLAIN[stage] : r ? r.summary : STAGE_PLAIN[stage]}</div>
        </div>
        {r && live !== "running" && (
          <button className="btn small ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide evidence" : "Evidence"}
          </button>
        )}
      </div>

      {r && live !== "running" && stage === "simulation" && r.tests.length > 0 && (
        <div className="row" style={{ marginTop: 10, gap: 6 }}>
          {r.tests.map((t) => (
            <span key={t.name} title={`${t.name}\n${t.covers.join(", ")}${t.message ? `\n${t.message}` : ""}`}>
              <Pill tone={statusTone(t.status)}>{t.name.replace("test_", "")}</Pill>
            </span>
          ))}
        </div>
      )}
      {r && live !== "running" && stage === "synthesis" && synth?.cells_total !== undefined && (
        <div className="grid four" style={{ marginTop: 12 }}>
          <div className="metric"><b>{synth.cells_total}</b><span>generic cells (estimate)</span></div>
          <div className="metric"><b>{synth.sequential_cells}</b><span>flip-flops</span></div>
          <div className="metric"><b>{synth.combinational_cells}</b><span>logic gates</span></div>
          <div className="metric"><b>{synth.latches}</b><span>latches</span></div>
        </div>
      )}
      {r && live !== "running" && stage === "formal" && r.properties.some((x) => x.status === "FAIL") && (
        <div className="notice bad small" style={{ marginTop: 10 }}>
          {r.properties.filter((x) => x.status === "FAIL").map((x) => (
            <div key={x.location}>
              Counterexample: assertion <span className="mono">{x.location}</span> fails after {x.step} clock cycles · covers {x.covers.join(", ")}
            </div>
          ))}
        </div>
      )}

      {r && live !== "running" && r.status !== "PASS" && !r.status.startsWith("BLOCKED") && onExplain && (
        <div style={{ marginTop: 12 }}>
          {explanation ? (
            <div className="notice info small">
              <b>Plain-English diagnosis</b> <span className="faint">(failure analyst via {explanation.provider}{explanation.mock ? ", mock rule-based" : ""}; advisory, the tool evidence above is authoritative)</span>
              <p style={{ margin: "6px 0" }}>{explanation.summary} {explanation.likely_cause}</p>
              <ul style={{ margin: "4px 0 6px", paddingLeft: 18 }}>{explanation.evidence.slice(0, 4).map((e) => <li key={e}>{e}</li>)}</ul>
              <div>Next step: {explanation.suggested_next_step}</div>
              {explanation.affects_requirements.length > 0 && <div className="faint">Affects: {explanation.affects_requirements.join(", ")}</div>}
            </div>
          ) : (
            <button className="btn small" onClick={() => onExplain(run!.id)}>Explain this error</button>
          )}
        </div>
      )}
      {r && live !== "running" && r.status.startsWith("BLOCKED") && (
        <div className="notice warn small" style={{ marginTop: 10 }}>{r.findings.map((f) => `${f.code}: ${f.message}`).join(" · ")}</div>
      )}

      {open && r && (
        <div className="stack" style={{ marginTop: 14 }}>
          <dl className="kv">
            <dt>Run</dt><dd className="mono">{run!.id} · source revision {run!.source_revision}</dd>
            <dt>Input hash</dt><dd className="mono">{r.input_hash}</dd>
            <dt>Execution</dt><dd>{r.execution.mode}{(r.execution as { note?: string }).note ? `: ${(r.execution as { note?: string }).note}` : ""}</dd>
            {tv && <><dt>Tool versions</dt><dd className="mono">{Object.entries(tv).map(([k, v]) => `${k} ${v ?? "n/a"}`).join(" · ")}</dd></>}
            <dt>Finished</dt><dd>{new Date(r.finished_at).toLocaleString()} ({r.duration_s.toFixed(2)} s tool time)</dd>
          </dl>
          {r.steps.map((s, i) => (
            <div key={i} className="card tight">
              <div className="row small">
                <b>{s.tool}</b> <span className="faint">{s.version}</span> <Pill tone={statusTone(s.status)}>{s.status}</Pill>
                <span className="faint">exit {s.exit_code ?? "–"} · {s.duration_s}s</span>
              </div>
              {s.command.length > 0 && <div className="mono small faint" style={{ margin: "6px 0", wordBreak: "break-all" }}>$ {s.command.join(" ")}</div>}
              <details>
                <summary>Raw log</summary>
                <pre className="log">{(s.stdout + (s.stderr ? `\n--- stderr ---\n${s.stderr}` : "")).slice(-30000) || "(empty)"}</pre>
              </details>
            </div>
          ))}
          {r.tests.length > 0 && (
            <table>
              <thead><tr><th>Test</th><th>Status</th><th>Requirements</th><th>Message</th></tr></thead>
              <tbody>
                {r.tests.map((t) => (
                  <tr key={t.name}>
                    <td className="mono small">{t.name}</td>
                    <td><Pill tone={statusTone(t.status)}>{t.status}</Pill></td>
                    <td className="small">{t.covers.join(", ")}</td>
                    <td className="small muted">{t.message ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {r.properties.length > 0 && (
            <table>
              <thead><tr><th>Property</th><th>Kind</th><th>Status</th><th>Requirements</th></tr></thead>
              <tbody>
                {r.properties.map((x) => (
                  <tr key={x.kind + x.location}>
                    <td className="mono small">{x.location}</td>
                    <td className="small">{x.kind}</td>
                    <td><Pill tone={statusTone(x.status)}>{x.status}{x.step != null ? ` @${x.step}` : ""}</Pill></td>
                    <td className="small">{x.covers.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {r.findings.length > 0 && (
            <div className="small">
              {r.findings.slice(0, 20).map((f, i) => (
                <div key={i}><Pill tone={f.severity === "error" ? "bad" : f.severity === "warning" ? "warn" : "neutral"}>{f.severity}</Pill> <span className="mono">{f.code}</span> {f.message}</div>
              ))}
            </div>
          )}
          {r.artifacts.length > 0 && (
            <div className="small muted">
              Artifacts: {r.artifacts.map((a) => <span key={a.path} className="mono" style={{ marginRight: 10 }}>{a.path} ({a.size} B, {a.sha256.slice(0, 10)}…)</span>)}
            </div>
          )}
          {stage === "synthesis" && synth?.area_basis && <div className="small faint">{synth.area_basis}</div>}
          {r.limitations.length > 0 && <ul className="small faint">{r.limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
          {stage === "formal" && r.artifacts.find((a) => a.path.endsWith(".vcd") && a.content) && (
            <details>
              <summary>Counterexample trace (VCD)</summary>
              <CodeView text={r.artifacts.find((a) => a.path.endsWith(".vcd"))!.content!.slice(0, 6000)} maxHeight={300} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}
