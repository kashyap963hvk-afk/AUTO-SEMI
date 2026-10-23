import { fieldMap, QUESTION_BY_KEY } from "../domain/fifo";
import type { ChecklistItem } from "../domain/release";
import type { DesignSpec } from "../domain/spec";
import { STAGE_LABEL, STAGES, type Stage } from "../eda/contracts";
import type { LatestRun } from "./project";

/** Both reports are generated from the same machine-readable evidence (spec section 17). */

function runLine(stage: Stage, r: LatestRun | undefined, currentRevision: number | null): string {
  if (!r) return `- **${STAGE_LABEL[stage]}**: NOT RUN`;
  const stale = r.source_revision !== currentRevision ? ` (STALE: from revision ${r.source_revision})` : "";
  const mode = r.result.execution.mode === "recorded" ? " [recorded real run reused by input hash]" : r.result.execution.mode === "live-wasm" ? " [Yosys/WASM in-process]" : r.result.execution.mode === "unavailable" ? " [not executed]" : " [live EDA worker]";
  return `- **${STAGE_LABEL[stage]}**: ${r.result.status}. ${r.result.summary}${stale}${mode}`;
}

export function userSummary(args: { name: string; spec: DesignSpec; level: { label: string }; latest: Partial<Record<Stage, LatestRun>>; revision: number | null; checklist: ChecklistItem[]; policyLabel: string }): string {
  const { spec } = args;
  const m = fieldMap(spec.fields);
  const lines = [
    `# ${args.name}: plain-English summary`,
    "",
    `**Where this stands:** ${args.level.label}. Release target: ${args.policyLabel}.`,
    "",
    "This is a learning/prototype result from an open-source flow. It is **not** a manufacturing-approved design, and nothing has been sent to a foundry.",
    "",
    "## What was built",
    `A first-in, first-out buffer that stores up to ${spec.parameters.DEPTH} values of ${spec.parameters.WIDTH} bits each, in the order they arrive. It reports when it is full, when it is empty, and how many values it holds.`,
    "",
    "## Your requirements and where they came from",
    ...spec.fields.map((f) => `- ${QUESTION_BY_KEY[f.key as keyof typeof QUESTION_BY_KEY]?.label ?? f.key}: **${f.value ?? "unknown"}**${f.unit && f.value !== null ? ` ${f.unit}` : ""} (${f.source}, ${f.status})`),
    "",
    "## What was checked",
    ...STAGES.map((s) => runLine(s, args.latest[s], args.revision)),
    "",
    "## Important limitations",
    "- Simulation runs only the listed tests. Formal results hold only under their stated assumptions.",
    "- Size figures come from generic logic gates. They are estimates, not silicon area, speed or power.",
    m.clock_mhz?.status !== "confirmed" ? "- The clock frequency is not confirmed, so timing could not be checked." : "- Timing is checked only by physical design, which needs approved constraints and a supported PDK.",
    "- DFT/scan, I/O pads and packaging are not addressed.",
    "",
    "## Remaining blockers",
    ...(args.checklist.filter((i) => i.requirement === "required" && i.status !== "pass").map((i) => `- ${i.title}: ${i.detail}`) || []),
    "",
    "## Next safe action",
    args.checklist.some((i) => i.requirement === "required" && i.status !== "pass" && i.id !== "human.signoff")
      ? "Resolve the blockers above, then create a release candidate for an engineer to review."
      : "Ask a qualified engineer to review the engineering report and sign off on the release candidate.",
    "",
  ];
  return lines.join("\n");
}

export function engineeringReport(args: {
  name: string;
  spec: DesignSpec;
  specRevision: number;
  specHash: string;
  source: { revision: number; manifest_hash: string; file_hashes: Record<string, string>; origin: string; provenance: Record<string, unknown> } | null;
  latest: Partial<Record<Stage, LatestRun>>;
  checklist: ChecklistItem[];
  level: { label: string };
}): string {
  const out: string[] = [
    `# ${args.name}: engineering report`,
    "",
    `- Result level: ${args.level.label}`,
    `- Specification: revision ${args.specRevision}, sha256 ${args.specHash}`,
    args.source ? `- Source revision ${args.source.revision} (${args.source.origin}), manifest sha256 ${args.source.manifest_hash}` : "- Source: none",
    "",
    "## Source checksums",
    ...(args.source ? Object.entries(args.source.file_hashes).map(([f, h]) => `- \`${f}\` ${h}`) : []),
    "",
    "## Requirement-to-verification traceability",
    "| Requirement | Methods | Tests (simulation) | Formal properties | Status |",
    "|---|---|---|---|---|",
  ];
  const sim = args.latest.simulation?.result;
  const formal = args.latest.formal?.result;
  for (const r of args.spec.requirements) {
    const tests = sim?.tests.filter((t) => t.covers.includes(r.id)) ?? [];
    const props = formal?.properties.filter((p) => p.covers.includes(r.id)) ?? [];
    const testStr = tests.length ? tests.map((t) => `${t.name}:${t.status}`).join("<br>") : "none";
    const propStr = props.length ? `${props.length} (${[...new Set(props.map((p) => p.status))].join("/")})` : formal ? (r.verification_method.includes("formal") ? `covered by ${formal.formal_status} proof (no failing property)` : "n/a") : "not run";
    const verified = r.verification_method.every((m) => {
      if (m === "simulation") return tests.length > 0 && tests.every((t) => t.status === "PASS");
      if (m === "formal") return formal?.status === "PASS";
      if (m === "lint") return args.latest.lint?.result.status === "PASS";
      return false;
    });
    out.push(`| ${r.id} ${r.title} | ${r.verification_method.join(", ")} | ${testStr} | ${propStr} | ${verified ? "evidence complete" : "GAP"} |`);
  }
  out.push("", "## Stage evidence");
  for (const s of STAGES) {
    const run = args.latest[s];
    out.push("", `### ${STAGE_LABEL[s]}`);
    if (!run) {
      out.push("NOT RUN");
      continue;
    }
    const r = run.result;
    out.push(
      `- Status: **${r.status}**${r.formal_status ? `; formal status **${r.formal_status}**` : ""}`,
      `- Summary: ${r.summary}`,
      `- Source revision: ${run.source_revision}; job input sha256: \`${r.input_hash}\``,
      `- Execution: ${r.execution.mode}${r.execution.mode === "recorded" ? " (a real tool run with identical inputs, reused; tools were not re-executed for this view)" : ""}`,
      `- Tool versions: ${JSON.stringify((r.execution as { tool_versions?: unknown }).tool_versions ?? {})}`,
      ...r.steps.map((st) => `- Step \`${st.tool}\` exit=${st.exit_code} status=${st.status} time=${st.duration_s}s: \`${st.command.join(" ").slice(0, 300)}\``),
      ...(Object.keys(r.metrics).length ? [`- Metrics: \`${JSON.stringify(r.metrics).slice(0, 1200)}\``] : []),
      ...r.findings.slice(0, 20).map((f) => `- Finding [${f.severity}] ${f.code}: ${f.message}`),
      ...r.limitations.map((l) => `- Limitation: ${l}`),
    );
  }
  out.push("", "## Release checklist", ...args.checklist.map((i) => `- [${i.status === "pass" ? "x" : " "}] ${i.title} (${i.requirement}): ${i.status}, ${i.detail}`));
  out.push(
    "",
    "## Not performed / unavailable",
    "- Code and functional coverage collection (not enabled on this path)",
    "- UVM (not supported by the configured cocotb + Icarus simulator)",
    "- Power analysis, DFT/ATPG, I/O and package planning",
    "- Foundry sign-off decks. Public-PDK checks are not foundry sign-off.",
    "",
  );
  return out.join("\n");
}
