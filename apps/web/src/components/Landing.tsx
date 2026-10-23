"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { api, Pill, useToast, type Tone } from "./ui";

const EXAMPLES = [
  { label: "UART receive buffer", text: "I need a small buffer chip that holds 16 bytes for a UART receiver, running at 50 MHz on SKY130. It's for a class project." },
  { label: "Sensor sample queue", text: "A FIFO queue that stores 32 sensor readings of 16 bits each until the microcontroller collects them. Prototype only." },
  { label: "Vague idea", text: "Something that remembers numbers in the order they come in." },
];

interface ProjectItem {
  id: string;
  name: string;
  status: { label: string; tone: string };
  updated_at: string;
}

export function Landing() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [projects, setProjects] = React.useState<ProjectItem[]>([]);
  const [toast, show] = useToast();

  React.useEffect(() => {
    api<ProjectItem[]>("/api/projects").then(setProjects).catch(() => {});
  }, []);

  async function start() {
    setBusy(true);
    try {
      const p = await api<{ id: string }>("/api/projects", { json: { name, description: text } });
      router.push(`/projects/${p.id}`);
    } catch (e) {
      show((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <section className="hero">
        <div>
          <Pill tone="info">Prototype flow · open-source EDA · honest evidence</Pill>
          <h1 style={{ marginTop: 14 }}>
            Describe the chip you need.
            <br />
            <span className="gradient-text">Get verified hardware you can review.</span>
          </h1>
          <p className="muted" style={{ fontSize: 17, maxWidth: 620 }}>
            Explain what the block should do in plain English. The assistant asks short questions, writes a reviewable specification, generates RTL,
            runs real lint, simulation, formal and synthesis tools, and shows you exactly what passed, what failed and what was never run.
          </p>
          <div className="flow">
            <div className="step"><b>1 · Describe</b><span>Plain-English intake. Nothing technical required.</span></div>
            <div className="step"><b>2 · Approve</b><span>You confirm every requirement. AI guesses stay labelled as proposals.</span></div>
            <div className="step"><b>3 · Verify</b><span>Verilator, cocotb, SymbiYosys and Yosys produce the evidence.</span></div>
            <div className="step"><b>4 · Review</b><span>A hashed package for a qualified engineer. Never auto-submitted.</span></div>
          </div>
        </div>
        <div className="card" style={{ boxShadow: "var(--shadow)" }}>
          <h2>Start a new chip</h2>
          <label className="field-label" htmlFor="desc">What should it do?</label>
          <textarea id="desc" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. A buffer that holds 16 bytes for my UART receiver…" rows={5} />
          <div className="examples">
            {EXAMPLES.map((e) => (
              <button key={e.label} className="chip" onClick={() => { setText(e.text); if (!name) setName(e.label); }}>
                {e.label}
              </button>
            ))}
          </div>
          <label className="field-label" htmlFor="name">Project name (optional)</label>
          <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="My first chip" />
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={busy || text.trim().length < 10} onClick={start}>
              {busy ? <span className="spin" /> : null} Start design
            </button>
            <span className="small faint">This release supports small synchronous FIFO buffers end to end.</span>
          </div>
        </div>
      </section>

      <section style={{ marginTop: 36 }}>
        <div className="row between">
          <h2>Your projects</h2>
          <span className="small faint">Projects are private to this browser session.</span>
        </div>
        {projects.length === 0 ? (
          <p className="muted">No projects yet. Pick an example above to try the full flow in about two minutes.</p>
        ) : (
          <div className="grid three">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="card tight" style={{ color: "inherit", textDecoration: "none" }}>
                <div className="row between">
                  <b>{p.name}</b>
                  <Pill tone={p.status.tone as Tone} dot>
                    {p.status.label}
                  </Pill>
                </div>
                <div className="small faint" style={{ marginTop: 6 }}>Updated {new Date(p.updated_at).toLocaleString()}</div>
              </Link>
            ))}
          </div>
        )}
      </section>
      <p className="footer-note">
        Results from public PDKs and open-source tools are prototype evidence, not foundry sign-off. A qualified engineer must review any package before fabrication.
      </p>
      {toast}
    </>
  );
}
