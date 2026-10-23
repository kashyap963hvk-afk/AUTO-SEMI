"use client";

import React from "react";
import { api, Pill, useToast, type Tone } from "../ui";
import { userStatus, type WorkflowState } from "@/lib/domain/workflow";
import type { Overview } from "./types";
import { Discovery } from "./Discovery";
import { SpecReview } from "./SpecReview";
import { ArchitecturePanel } from "./ArchitecturePanel";
import { DesignPanel } from "./DesignPanel";
import { VerificationPanel } from "./VerificationPanel";
import { PhysicalPanel } from "./PhysicalPanel";
import { ReportsPanel } from "./ReportsPanel";
import { ReleasePanel } from "./ReleasePanel";
import { AiPolicyPanel } from "./AiPolicyPanel";
import { AuditPanel } from "./AuditPanel";

const TABS = [
  { id: "discovery", label: "Guided discovery" },
  { id: "spec", label: "Specification" },
  { id: "architecture", label: "Architecture" },
  { id: "design", label: "RTL design" },
  { id: "verification", label: "Verification" },
  { id: "physical", label: "Physical design" },
  { id: "reports", label: "Reports" },
  { id: "release", label: "Release" },
  { id: "ai", label: "AI & data policy" },
  { id: "audit", label: "Audit trail" },
] as const;

function tabForState(ov: Overview): string {
  const s = ov.project.state;
  if (["DRAFT", "REQUIREMENTS_IN_PROGRESS", "BLOCKED_AI_PROVIDER"].includes(s)) return "discovery";
  if (s === "SPEC_REVIEW_REQUIRED") return "spec";
  if (s === "SPEC_APPROVED" || s === "ARCHITECTURE_REVIEW_REQUIRED") return "architecture";
  if (s === "RTL_GENERATING" && !ov.project.data.source_revision) return "design";
  if (["RELEASE_REVIEW_REQUIRED", "RELEASE_APPROVED", "PACKAGE_EXPORTED"].includes(s)) return "release";
  return "verification";
}

function tabProgress(id: string, ov: Overview): "done" | "now" | "bad" | "" {
  const d = ov.project.data;
  const runs = ov.latestRuns;
  const cur = (s: keyof Overview["latestRuns"]) => runs[s] && runs[s]!.source_revision === d.source_revision ? runs[s]!.result.status : null;
  switch (id) {
    case "discovery":
      return ov.interview.done ? "done" : "now";
    case "spec":
      return d.spec_approved_revision ? "done" : ov.project.state === "SPEC_REVIEW_REQUIRED" ? "now" : "";
    case "architecture":
      return d.architecture_approved_revision ? "done" : ov.project.state === "ARCHITECTURE_REVIEW_REQUIRED" || ov.project.state === "SPEC_APPROVED" ? "now" : "";
    case "design":
      return d.source_revision ? "done" : d.architecture_approved_revision ? "now" : "";
    case "verification": {
      const st = (["lint", "simulation", "formal", "synthesis"] as const).map(cur);
      if (st.some((x) => x && x !== "PASS")) return "bad";
      return st.every((x) => x === "PASS") ? "done" : d.source_revision ? "now" : "";
    }
    case "physical":
      return cur("physical") === "PASS" ? "done" : cur("physical") ? "bad" : "";
    case "release":
      return ov.project.state === "PACKAGE_EXPORTED" ? "done" : ov.project.state.startsWith("RELEASE") ? "now" : "";
    default:
      return "";
  }
}

export function Workspace({ id }: { id: string }) {
  const [ov, setOv] = React.useState<Overview | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<string | null>(null);
  const [toast, show] = useToast();

  const reload = React.useCallback(async () => {
    try {
      const data = await api<Overview>(`/api/projects/${id}`);
      setOv(data);
      setTab((t) => t ?? tabForState(data));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (err) return <div className="notice bad">{err}</div>;
  if (!ov || !tab) return <div className="row muted"><span className="spin" /> Loading project…</div>;

  const status = userStatus(ov.project.state as WorkflowState);
  const props = { ov, reload, toast: show, go: setTab };
  return (
    <>
      <div className="ws-head">
        <h1>{ov.project.name}</h1>
        <Pill tone={status.tone as Tone} dot pulse={status.tone === "run"}>
          {status.label}
        </Pill>
        <span className="pill neutral mono" title="Internal workflow state">{ov.project.state}</span>
        <span className="spacer" />
        <Pill tone={ov.level.level >= 3 ? "good" : ov.level.level >= 0 ? "info" : "neutral"}>{ov.level.label}</Pill>
      </div>
      <div className="ws">
        <nav className="rail" aria-label="Design stages">
          {TABS.map((t, i) => {
            const prog = tabProgress(t.id, ov);
            return (
              <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
                <span className={`num ${prog}`}>{prog === "done" ? "✓" : prog === "bad" ? "!" : i + 1}</span>
                {t.label}
              </button>
            );
          })}
        </nav>
        <section>
          {tab === "discovery" && <Discovery {...props} />}
          {tab === "spec" && <SpecReview {...props} />}
          {tab === "architecture" && <ArchitecturePanel {...props} />}
          {tab === "design" && <DesignPanel {...props} />}
          {tab === "verification" && <VerificationPanel {...props} />}
          {tab === "physical" && <PhysicalPanel {...props} />}
          {tab === "reports" && <ReportsPanel {...props} />}
          {tab === "release" && <ReleasePanel {...props} />}
          {tab === "ai" && <AiPolicyPanel {...props} />}
          {tab === "audit" && <AuditPanel {...props} />}
        </section>
      </div>
      {toast}
    </>
  );
}
