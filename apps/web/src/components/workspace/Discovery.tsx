"use client";

import React from "react";
import { api, Pill, SourceBadge } from "../ui";
import { QUESTIONS } from "@/lib/domain/fifo";
import type { PanelProps } from "./types";

export function Discovery({ ov, reload, toast, go }: PanelProps) {
  const p = ov.project;
  const { question: q, field } = ov.interview;
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const chatRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
    setValue("");
  }, [p.data.conversation.length]);

  async function send(action: string, v?: unknown) {
    setBusy(true);
    try {
      await api(`/api/projects/${p.id}/requirements/messages`, { json: action === "skip_extraction" ? { action } : { key: q!.key, action, value: v } });
      await reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    try {
      await api(`/api/projects/${p.id}/specification/generate`, { json: {} });
      await reload();
      go("spec");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const answeredCount = p.data.answered.length;
  const ext = p.data.extraction;
  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 0.75fr)" }}>
      <div className="stack">
        <div className="card">
          <div className="card-title">
            <h2>Guided discovery</h2>
            <span className="small muted">
              {answeredCount} / {QUESTIONS.length} answered
            </span>
          </div>
          <div className="chat" ref={chatRef}>
            {p.data.conversation.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                {m.text}
                {m.meta && "provider" in m.meta ? (
                  <span className="meta">
                    {String(m.meta.agent)} via {String(m.meta.provider)}
                    {m.meta.mock ? " · MOCK (deterministic rules, not a language model)" : ""}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        {p.state === "BLOCKED_AI_PROVIDER" && (
          <div className="notice warn">
            The configured AI model is unavailable or not allowed by this project&apos;s data policy. Nothing was sent to any other provider.{" "}
            <button className="btn small" onClick={() => send("skip_extraction")} disabled={busy}>
              Continue without AI extraction
            </button>
          </div>
        )}

        {q && p.state !== "BLOCKED_AI_PROVIDER" && (
          <div className="question">
            <div className="row between">
              <span className="small muted">Question {QUESTIONS.findIndex((x) => x.key === q.key) + 1} of {QUESTIONS.length}</span>
              {q.criticality === "rtl" ? <Pill tone="warn">Needed for the design</Pill> : <Pill tone="info">Needed for layout & timing</Pill>}
            </div>
            <h3 style={{ marginTop: 10 }}>{q.prompt}</h3>
            <p className="small muted">
              <b>Why we ask:</b> {q.why}
            </p>
            {field?.status === "proposed" && field.value !== null && (
              <div className="notice info" style={{ marginBottom: 10 }}>
                {field.rationale} Proposed value: <b>{String(field.value)}</b>{" "}
                <button className="btn small primary" onClick={() => send("confirm")} disabled={busy}>
                  Yes, that&apos;s right
                </button>
              </div>
            )}
            {q.kind === "choice" ? (
              <div className="opts">
                {q.options!.map((o) => (
                  <button key={String(o.value)} className="opt" onClick={() => send("know", o.value)} disabled={busy}>
                    {o.label}
                    {o.hint && <small>{o.hint}</small>}
                  </button>
                ))}
              </div>
            ) : (
              <div className="row" style={{ margin: "12px 0" }}>
                <input
                  type="number"
                  style={{ maxWidth: 200 }}
                  value={value}
                  min={q.min}
                  max={q.max}
                  placeholder={`${q.min}–${q.max}`}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && value && send("know", Number(value))}
                />
                <span className="muted">{q.unit}</span>
                <button className="btn" disabled={busy || !value} onClick={() => send("know", Number(value))}>
                  I know: use this
                </button>
              </div>
            )}
            <div className="row">
              <button className="btn ghost" onClick={() => send("suggest")} disabled={busy}>
                Suggest one for me
              </button>
              <button className="btn ghost" onClick={() => send("unsure")} disabled={busy}>
                Not sure
              </button>
              <span className="small faint">If unsure: {q.ifUnknown}</span>
            </div>
          </div>
        )}

        {!q && (
          <div className="card">
            <h3>All questions answered</h3>
            <p className="muted">Next, review a structured specification. Nothing is final until you approve it.</p>
            <button className="btn primary" onClick={generate} disabled={busy || !["REQUIREMENTS_IN_PROGRESS", "SPEC_REVIEW_REQUIRED"].includes(p.state)}>
              {busy ? <span className="spin" /> : null} Generate specification for review
            </button>
          </div>
        )}
      </div>

      <div className="stack">
        <div className="card">
          <h3>What we know so far</h3>
          <table>
            <tbody>
              {QUESTIONS.map((qq) => {
                const f = p.data.fields.find((x) => x.key === qq.key)!;
                return (
                  <tr key={qq.key}>
                    <td className="muted">{qq.label}</td>
                    <td>
                      <b>{f.value === null ? "–" : String(f.value)}</b> {f.value !== null && qq.unit ? <span className="muted">{qq.unit}</span> : null}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <SourceBadge source={f.source} status={f.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {ext && (
          <div className="card tight small">
            <b>Requirements analyst</b>
            <div className="muted">
              {ext.provider}
              {ext.mock ? " · mock provider (rule-based)" : ""} · execution <span className="mono">{ext.execution_id}</span>
            </div>
            {ext.warnings.filter((w) => !w.startsWith("MOCK")).map((w) => (
              <div key={w} className="faint">⚠ {w}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
