"use client";

import React from "react";

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    cache: "no-store",
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof data === "object" && data && "error" in data ? String((data as { error: string }).error) : `HTTP ${res.status}`);
  return data as T;
}

export type Tone = "good" | "warn" | "bad" | "info" | "run" | "neutral";

export function Pill({ tone = "neutral", children, dot, pulse }: { tone?: Tone; children: React.ReactNode; dot?: boolean; pulse?: boolean }) {
  return (
    <span className={`pill ${tone}`}>
      {dot && <span className={`dot ${pulse ? "pulse" : ""}`} />}
      {children}
    </span>
  );
}

export function statusTone(status: string | null | undefined): Tone {
  if (!status) return "neutral";
  if (status === "PASS" || status === "PROVED" || status === "pass" || status === "REACHED") return "good";
  if (status === "BOUNDED_PASS_ONLY") return "info";
  if (status.startsWith("BLOCKED") || status === "missing" || status === "waiting" || status === "stale" || status === "NOT_RUN" || status === "UNKNOWN") return "warn";
  if (status === "not_applicable") return "neutral";
  return "bad";
}

const MODE_LABEL: Record<string, { label: string; tone: Tone; title: string }> = {
  "live-worker": { label: "Live EDA worker", tone: "good", title: "Executed just now by the connected EDA worker" },
  recorded: { label: "Recorded real run", tone: "info", title: "A real tool run with byte-identical inputs (SHA-256 match), reused. Tools were not re-run now." },
  "live-wasm": { label: "Yosys · WebAssembly", tone: "run", title: "Real Yosys compiled to WebAssembly, executed inside this server just now" },
  unavailable: { label: "Not executed", tone: "warn", title: "No tool was available. Nothing was fabricated." },
};

export function ModeBadge({ mode }: { mode: string }) {
  const m = MODE_LABEL[mode] ?? { label: mode, tone: "neutral" as Tone, title: mode };
  return (
    <span title={m.title}>
      <Pill tone={m.tone}>{m.label}</Pill>
    </span>
  );
}

export function SourceBadge({ source, status }: { source: string; status: string }) {
  const tone: Tone = status === "confirmed" ? (source === "user-confirmed" ? "good" : "info") : status === "proposed" ? "warn" : status === "unknown" ? "neutral" : "bad";
  const label = source === "user-confirmed" ? "You confirmed" : source === "ai-proposed" ? (status === "confirmed" ? "AI proposal · accepted" : "AI proposal") : source === "tool-derived" ? "Unknown" : source;
  return <Pill tone={tone}>{label}</Pill>;
}

const SV_KW = /\b(module|endmodule|input|output|wire|reg|parameter|localparam|always|begin|end|if|else|assign|posedge|negedge|or|assert|assume|cover|initial)\b/g;

function highlight(line: string): React.ReactNode {
  const m = line.match(/^(.*?)(\/\/.*|#.*)?$/);
  const code = m?.[1] ?? line;
  const comment = m?.[2];
  const parts: React.ReactNode[] = [];
  let last = 0;
  const re = new RegExp(`${SV_KW.source}|(\\$[a-z_]+)|(\`[a-z]+)|(\\b\\d+'[bdh][0-9a-fA-F_]+|\\b\\d+\\b)`, "g");
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(code))) {
    if (mm.index > last) parts.push(code.slice(last, mm.index));
    const cls = mm[1] ? "kw" : mm[2] || mm[3] ? "sys" : "num";
    parts.push(
      <span key={mm.index} className={cls}>
        {mm[0]}
      </span>,
    );
    last = mm.index + mm[0].length;
  }
  parts.push(code.slice(last));
  if (comment) parts.push(<span key="c" className="cm">{comment}</span>);
  return parts;
}

export function CodeView({ text, diff = false, maxHeight }: { text: string; diff?: boolean; maxHeight?: number }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre className="code" style={maxHeight ? { maxHeight } : undefined}>
      {lines.map((l, i) => {
        const cls = diff ? (l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "") : "";
        return (
          <span key={i} className={`l ${cls}`}>
            <span className="ln">{i + 1}</span>
            {diff ? l : highlight(l)}
          </span>
        );
      })}
    </pre>
  );
}

/** Small Markdown renderer for the generated reports (headings, lists, tables, code, bold). */
export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  const inline = (s: string, key: string | number) => {
    const out: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|<br>)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let k = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const t = m[0];
      if (t === "<br>") out.push(<br key={`${key}-${k++}`} />);
      else if (t.startsWith("**")) out.push(<strong key={`${key}-${k++}`}>{t.slice(2, -2)}</strong>);
      else out.push(<code key={`${key}-${k++}`}>{t.slice(1, -1)}</code>);
      last = m.index + t.length;
    }
    out.push(s.slice(last));
    return out;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (l.startsWith("### ")) blocks.push(<h3 key={i}>{inline(l.slice(4), i)}</h3>);
    else if (l.startsWith("## ")) blocks.push(<h2 key={i}>{inline(l.slice(3), i)}</h2>);
    else if (l.startsWith("# ")) blocks.push(<h1 key={i}>{inline(l.slice(2), i)}</h1>);
    else if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|[-| ]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split("|").map((c) => c.trim()));
        i++;
      }
      i--;
      blocks.push(
        <div key={i} style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>{rows[0].map((c, j) => <th key={j}>{inline(c, `h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${ri}-${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (l.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(lines[i++].slice(2));
      i--;
      blocks.push(
        <ul key={i}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${i}-${j}`)}</li>
          ))}
        </ul>,
      );
    } else blocks.push(<p key={i}>{inline(l, i)}</p>);
  }
  return <div className="md">{blocks}</div>;
}

export function useToast(): [React.ReactNode, (msg: string, tone?: "bad" | "good" | "info") => void] {
  const [t, setT] = React.useState<{ msg: string; tone: string } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = React.useCallback((msg: string, tone: "bad" | "good" | "info" = "bad") => {
    setT({ msg, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setT(null), 4500);
  }, []);
  const node = t ? (
    <div className={`notice ${t.tone} toast`} role="status" onClick={() => setT(null)}>
      {t.msg}
    </div>
  ) : null;
  return [node, show];
}
