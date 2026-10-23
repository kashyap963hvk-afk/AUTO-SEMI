"use client";

import React from "react";
import { api, Pill, statusTone } from "../ui";
import { RELEASE_POLICIES, type ChecklistItem } from "@/lib/domain/release";
import type { PanelProps } from "./types";

interface Candidate {
  id: string;
  source_revision: number;
  policy: string;
  checklist: ChecklistItem[];
  status: string;
  approval: { approver_name: string; approver_role: string; approved_at: string } | null;
  manifest_hash: string | null;
  created_at: string;
}

function Checklist({ items }: { items: ChecklistItem[] }) {
  return (
    <table>
      <tbody>
        {items.map((i) => (
          <tr key={i.id}>
            <td style={{ width: 28 }}>{i.status === "pass" ? "✅" : i.status === "not_applicable" ? "⚪" : i.status === "waiting" ? "⏳" : i.status === "fail" ? "❌" : "⚠️"}</td>
            <td>
              <b>{i.title}</b>
              <div className="small muted">{i.detail}</div>
            </td>
            <td className="small faint">{i.requirement.replace("_", " ")}</td>
            <td><Pill tone={statusTone(i.status)}>{i.status.replace("_", " ")}</Pill></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReleasePanel({ ov, reload, toast }: PanelProps) {
  const p = ov.project;
  const [cands, setCands] = React.useState<Candidate[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("");
  const [qualified, setQualified] = React.useState(false);
  const [ackOpen, setAckOpen] = React.useState(false);
  const [verify, setVerify] = React.useState<{ ok: boolean; checked: number; problems: string[] } | null>(null);

  const load = React.useCallback(() => api<Candidate[]>(`/api/projects/${p.id}/release-candidates`).then(setCands).catch(() => {}), [p.id]);
  React.useEffect(() => {
    load();
  }, [load, p.updated_at]);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try {
      await fn();
      await reload();
      await load();
      if (ok) toast(ok, "good");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportZip(c: Candidate) {
    setBusy(true);
    try {
      const res = await fetch(`/api/release-candidates/${c.id}/export`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "release.zip";
      a.click();
      URL.revokeObjectURL(url);
      const v = await fetch("/api/release-packages/verify", { method: "POST", body: blob });
      setVerify(await v.json());
      await reload();
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyFile(f: File) {
    const v = await fetch("/api/release-packages/verify", { method: "POST", body: f });
    setVerify(await v.json());
  }

  const latest = cands.find((c) => c.source_revision === p.data.source_revision);
  const openItems = (latest?.checklist ?? ov.checklist).filter((i) => i.requirement !== "required" && i.status !== "pass");
  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">
          <div>
            <h2>Release Center</h2>
            <span className="small muted">The release target decides which checks are mandatory. Export always requires a qualified human sign-off.</span>
          </div>
        </div>
        <div className="grid two">
          {(Object.keys(RELEASE_POLICIES) as (keyof typeof RELEASE_POLICIES)[]).map((k) => (
            <label key={k} className="card tight check" style={{ borderColor: p.data.release_policy === k ? "var(--accent)" : undefined }}>
              <input type="radio" name="policy" checked={p.data.release_policy === k} onChange={() => act(() => api(`/api/projects/${p.id}/release-policy`, { json: { policy: k } }))} />
              <span>
                <b>{RELEASE_POLICIES[k].label}</b>
                <div className="small muted">{RELEASE_POLICIES[k].description}</div>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h3>Release checklist (current revision {p.data.source_revision ?? "–"})</h3>
          <button className="btn primary" disabled={busy || !p.data.source_revision} onClick={() => act(() => api(`/api/projects/${p.id}/release-candidates`, { method: "POST" }), undefined)}>
            Create release candidate
          </button>
        </div>
        <Checklist items={ov.checklist} />
      </div>

      {cands.map((c) => (
        <div key={c.id} className="card">
          <div className="card-title">
            <div>
              <b className="mono">{c.id}</b> <span className="small muted">rev {c.source_revision} · {c.policy} · {new Date(c.created_at).toLocaleString()}</span>
            </div>
            <Pill tone={c.status === "blocked" ? "bad" : c.status === "exported" ? "good" : c.status === "approved" ? "good" : "warn"}>
              {c.status === "blocked" ? "Blocked" : c.status === "review_required" ? "Waiting for human review" : c.status === "approved" ? "Approved by human reviewer" : "Package created (not submitted)"}
            </Pill>
          </div>
          {c.status === "blocked" && (
            <div className="notice bad small">
              Export refused: {c.checklist.filter((i) => i.requirement === "required" && i.status !== "pass" && i.id !== "human.signoff").map((i) => i.title).join("; ")}
            </div>
          )}
          {c.status === "review_required" && c.source_revision === p.data.source_revision && (
            <div className="stack">
              <div className="grid two">
                <input type="text" placeholder="Reviewer name" value={name} onChange={(e) => setName(e.target.value)} />
                <input type="text" placeholder="Role (e.g. ASIC design engineer)" value={role} onChange={(e) => setRole(e.target.value)} />
              </div>
              <label className="check small">
                <input type="checkbox" checked={qualified} onChange={(e) => setQualified(e.target.checked)} />
                <span>I am a qualified human reviewer. I have reviewed the engineering report and evidence. The AI is not signing off on my behalf.</span>
              </label>
              {openItems.length > 0 && (
                <label className="check small">
                  <input type="checkbox" checked={ackOpen} onChange={(e) => setAckOpen(e.target.checked)} />
                  <span>I accept these open, non-mandatory items for this package: {openItems.map((i) => i.title).join("; ")}.</span>
                </label>
              )}
              <div>
                <button
                  className="btn primary"
                  disabled={busy || !qualified || !name.trim() || !role.trim() || (openItems.length > 0 && !ackOpen)}
                  onClick={() => act(() => api(`/api/release-candidates/${c.id}/approve`, { json: { approver_name: name, approver_role: role, qualified_reviewer: qualified, accepted_open_issues: ackOpen ? openItems.map((i) => i.id) : [] } }), "Release candidate approved.")}
                >
                  Sign off release candidate
                </button>
              </div>
            </div>
          )}
          {c.approval && (
            <div className="small muted" style={{ marginBottom: 8 }}>
              Signed off by <b>{c.approval.approver_name}</b> ({c.approval.approver_role}) at {new Date(c.approval.approved_at).toLocaleString()}
            </div>
          )}
          {(c.status === "approved" || c.status === "exported") && (
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => exportZip(c)}>⬇ Export release package (ZIP)</button>
              {c.manifest_hash && <span className="small mono faint">manifest sha256 {c.manifest_hash.slice(0, 20)}…</span>}
            </div>
          )}
        </div>
      ))}

      <div className="card">
        <h3>Verify a package</h3>
        <p className="small muted">Every file in an exported package is listed in release/sha256sums.txt and manifest.json. Upload a package to recompute every checksum.</p>
        <input type="file" accept=".zip" onChange={(e) => e.target.files?.[0] && verifyFile(e.target.files[0])} />
        {verify && (
          <div className={`notice ${verify.ok ? "good" : "bad"} small`} style={{ marginTop: 10 }}>
            {verify.ok ? `Integrity verified: ${verify.checked} files match their SHA-256 checksums.` : `Verification failed: ${verify.problems.join("; ")}`}
          </div>
        )}
        <p className="small faint" style={{ marginTop: 10 }}>
          &quot;Package created&quot; does not mean submitted or accepted by a foundry. This application has no foundry integration and never submits anything.
        </p>
      </div>
    </div>
  );
}
