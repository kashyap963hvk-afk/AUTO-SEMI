"use client";

import React from "react";
import { api, Markdown } from "../ui";
import type { PanelProps } from "./types";

export function ReportsPanel({ ov }: PanelProps) {
  const p = ov.project;
  const [kind, setKind] = React.useState<"user" | "engineering">("user");
  const [text, setText] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    setText(null);
    api<string>(`/api/projects/${p.id}/reports?kind=${kind}`).then(setText).catch((e) => setErr(e.message));
  }, [p.id, kind, p.updated_at]);

  return (
    <div className="card">
      <div className="tabs">
        <button className={kind === "user" ? "active" : ""} onClick={() => setKind("user")}>Plain-English summary</button>
        <button className={kind === "engineering" ? "active" : ""} onClick={() => setKind("engineering")}>Engineering report</button>
      </div>
      {err && !text ? <p className="muted">{err === "approved specification not found" ? "Reports become available once the specification is approved." : err}</p> : text ? <Markdown text={text} /> : <span className="spin" />}
    </div>
  );
}
