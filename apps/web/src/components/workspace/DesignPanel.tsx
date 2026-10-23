"use client";

import React from "react";
import { api, CodeView, Pill } from "../ui";
import type { PanelProps } from "./types";

interface SourceRow {
  revision: number;
  parent_revision: number | null;
  origin: string;
  files: Record<string, string>;
  file_hashes: Record<string, string>;
  manifest_hash: string;
  provenance: Record<string, unknown>;
  created_at: string;
  revisions: { revision: number; origin: string; manifest_hash: string; created_at: string }[];
}

export function DesignPanel({ ov, reload, toast, go }: PanelProps) {
  const p = ov.project;
  const [row, setRow] = React.useState<SourceRow | null>(null);
  const [file, setFile] = React.useState("rtl/sync_fifo.sv");
  const [defect, setDefect] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(
    (rev?: number) =>
      api<SourceRow>(`/api/projects/${p.id}/rtl${rev ? `?revision=${rev}` : ""}`)
        .then(setRow)
        .catch((e) => toast(e.message)),
    [p.id, toast],
  );
  React.useEffect(() => {
    if (p.data.source_revision) load();
  }, [p.data.source_revision, load]);

  async function generate() {
    setBusy(true);
    try {
      await api(`/api/projects/${p.id}/rtl/generate`, { json: { inject_defect: defect ? "full_off_by_one" : null } });
      await reload();
      toast(defect ? "RTL generated with a deliberate demo defect. Run the checks to see it caught." : "RTL revision generated.", "info");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!p.data.architecture_approved_revision) return <div className="card"><h2>RTL design</h2><p className="muted">Approve the architecture first.</p></div>;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">
          <div>
            <h2>RTL design</h2>
            <span className="small muted">Synthesizable Verilog/SystemVerilog generated from the approved spec by a deterministic, versioned template. Every revision is immutable and hashed.</span>
          </div>
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={generate}>
            {busy ? <span className="spin" /> : null} {p.data.source_revision ? "Generate new revision" : "Generate RTL"}
          </button>
          <label className="check small">
            <input type="checkbox" checked={defect} onChange={(e) => setDefect(e.target.checked)} />
            <span>Demo: inject a known defect (full flag one entry early) to see failure handling</span>
          </label>
          <span className="spacer" />
          {p.data.source_revision && <button className="btn" onClick={() => go("verification")}>Run checks →</button>}
        </div>
      </div>
      {row && (
        <div className="card">
          <div className="row between" style={{ marginBottom: 10 }}>
            <div className="row">
              {row.revisions.map((r) => (
                <button key={r.revision} className={`btn small ${r.revision === row.revision ? "" : "ghost"}`} onClick={() => load(r.revision)} title={r.manifest_hash}>
                  rev {r.revision} · {r.origin}
                </button>
              ))}
            </div>
            <span className="small muted mono">manifest {row.manifest_hash.slice(0, 16)}…</span>
          </div>
          {row.origin.includes("demo-defect") && <div className="notice warn small" style={{ marginBottom: 10 }}>This revision contains a deliberately injected defect for demonstration.</div>}
          <div className="tabs">
            {Object.keys(row.files).sort().map((f) => (
              <button key={f} className={file === f ? "active" : ""} onClick={() => setFile(f)}>
                {f}
              </button>
            ))}
          </div>
          <div className="row between small muted" style={{ marginBottom: 8 }}>
            <span className="mono">sha256 {row.file_hashes[file]}</span>
            <span>{String(row.provenance.generator_kind ?? row.provenance.generator ?? "")}</span>
          </div>
          {row.files[file] ? <CodeView text={row.files[file]} /> : <p className="muted">Not present in this revision.</p>}
          {!row.files["constraints/approved.sdc"] && (
            <p className="small faint" style={{ marginTop: 8 }}>No SDC draft: the clock frequency is not confirmed, so timing constraints are incomplete (TIMING_CONSTRAINTS_INCOMPLETE).</p>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <Pill tone="neutral">parent rev {row.parent_revision ?? "–"}</Pill>
            <Pill tone="neutral">spec rev {String(row.provenance.spec_revision ?? "")}</Pill>
          </div>
        </div>
      )}
    </div>
  );
}
