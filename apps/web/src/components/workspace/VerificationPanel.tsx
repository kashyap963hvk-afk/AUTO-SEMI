"use client";

import React from "react";
import { api, CodeView, Pill } from "../ui";
import type { Stage } from "@/lib/eda/contracts";
import { StageCard, type LiveState } from "./StageCard";
import type { PanelProps } from "./types";

const RTL_STAGES: Stage[] = ["lint", "simulation", "formal", "synthesis"];

type Proposal =
  | { available: true; proposal_hash: string; files_changed: string[]; diff: string; rationale: string; round: number; limit: number }
  | { available: false; reason: string };

export function VerificationPanel({ ov, reload, toast, go }: PanelProps) {
  const p = ov.project;
  const [live, setLive] = React.useState<Partial<Record<Stage, LiveState>>>({});
  const [running, setRunning] = React.useState(false);
  const [proposal, setProposal] = React.useState<Proposal | null>(null);
  const [explaining, setExplaining] = React.useState<string | null>(null);

  React.useEffect(() => {
    setProposal(null);
  }, [p.data.source_revision, p.state]);

  async function runAll() {
    setRunning(true);
    setLive({});
    try {
      const res = await fetch(`/api/projects/${p.id}/runs/all`, { method: "POST" });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({ error: `HTTP ${res.status}` }))).error);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "stage_started") setLive((l) => ({ ...l, [ev.stage]: "running" }));
          if (ev.type === "stage_finished") {
            setLive((l) => ({ ...l, [ev.stage]: "done" }));
            await reload();
          }
          if (ev.type === "error") toast(ev.error);
          if (ev.type === "stopped") toast(`Stopped: ${ev.reason}. Later checks did not run.`, "info");
          if (ev.type === "done") toast("All RTL checks passed on this revision.", "good");
        }
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setRunning(false);
      setLive({});
      await reload();
    }
  }

  async function explain(runId: string) {
    setExplaining(runId);
    try {
      await api(`/api/projects/${p.id}/explain/${runId}`, { method: "POST" });
      await reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setExplaining(null);
    }
  }

  async function loadProposal() {
    try {
      setProposal(await api<Proposal>(`/api/projects/${p.id}/repair`));
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function applyFix() {
    if (!proposal || !proposal.available) return;
    try {
      await api(`/api/projects/${p.id}/repair`, { json: { proposal_hash: proposal.proposal_hash } });
      setProposal(null);
      await reload();
      toast("Fix applied as a new revision. The failed revision is preserved. Re-running every check.", "info");
      setTimeout(runAll, 300);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  if (!p.data.source_revision) {
    return (
      <div className="card">
        <h2>Verification Center</h2>
        <p className="muted">Generate an RTL revision first.</p>
        <button className="btn" onClick={() => go("design")}>Go to RTL design</button>
      </div>
    );
  }

  function explanationFor(runId: string | undefined) {
    const e = runId ? p.data.explanations[runId] : undefined;
    if (!e) return null;
    return { ...(e.output as { summary: string; likely_cause: string; evidence: string[]; suggested_next_step: string; affects_requirements: string[] }), provider: e.provider, mock: e.mock };
  }

  const passed = RTL_STAGES.filter((s) => ov.latestRuns[s]?.source_revision === p.data.source_revision && ov.latestRuns[s]?.result.status === "PASS").length;
  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">
          <div>
            <h2>Verification Center</h2>
            <span className="small muted">
              Revision {p.data.source_revision} · {passed}/4 RTL checks passed · repair rounds used {p.data.repair_rounds}/{p.data.repair_limit}
            </span>
          </div>
          <button className="btn primary" disabled={running} onClick={runAll}>
            {running ? <span className="spin" /> : "▶"} {running ? "Running checks…" : "Run all checks"}
          </button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Checks run in order and stop at the first failure. Pass/fail comes only from tool exit codes and parsed reports, never from AI prose. A green badge never appears for a check that did not run.
        </p>
      </div>

      {RTL_STAGES.map((s) => (
        <StageCard
          key={s}
          stage={s}
          run={ov.latestRuns[s]}
          current={p.data.source_revision}
          live={live[s] ?? "idle"}
          onExplain={explaining ? undefined : explain}
          explanation={explanationFor(ov.latestRuns[s]?.id)}
        />
      ))}

      {p.state === "REPAIR_REQUIRED" && (
        <div className="card">
          <div className="card-title">
            <h3>Bounded repair</h3>
            <Pill tone="warn">round {p.data.repair_rounds + 1} of {p.data.repair_limit}</Pill>
          </div>
          <p className="small muted">
            The assistant may propose a minimal fix as a <b>new</b> revision. It may not edit tests, assertions or requirements, and the failed revision stays on record. You decide whether to apply it.
          </p>
          {!proposal && <button className="btn" onClick={loadProposal}>Propose a fix</button>}
          {proposal && !proposal.available && <div className="notice warn">{proposal.reason}</div>}
          {proposal && proposal.available && (
            <div className="stack">
              <div className="small">{proposal.rationale}</div>
              <CodeView text={proposal.diff} diff maxHeight={320} />
              <div className="row">
                <button className="btn primary" onClick={applyFix}>Apply fix as new revision and re-run</button>
                <button className="btn ghost" onClick={() => setProposal(null)}>Discard</button>
              </div>
            </div>
          )}
        </div>
      )}

      {p.state === "PROTOTYPE_CHECKS_PASSED" && (
        <div className="notice good row between">
          <span>Prototype checks passed: lint, simulation, formal proof and synthesis on revision {p.data.source_revision}. Physical design and release review are next.</span>
          <span className="row">
            <button className="btn small" onClick={() => go("physical")}>Physical design</button>
            <button className="btn small primary" onClick={() => go("release")}>Release review</button>
          </span>
        </div>
      )}
    </div>
  );
}
