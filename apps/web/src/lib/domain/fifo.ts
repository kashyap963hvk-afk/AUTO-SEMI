import type { DesignSpec, FieldSource, FieldStatus, Requirement, SpecField } from "./spec";

/** Which downstream work a field blocks while it is unknown/unaccepted. */
export type Criticality = "rtl" | "physical" | "none";

export interface ChoiceOption {
  value: string | number | boolean;
  label: string;
  hint?: string;
}

export interface Question {
  key: FieldKey;
  label: string;
  prompt: string;
  why: string;
  ifUnknown: string;
  criticality: Criticality;
  unit?: string;
  kind: "number" | "choice";
  options?: ChoiceOption[];
  min?: number;
  max?: number;
  suggestion: { value: string | number | boolean; rationale: string };
}

export type FieldKey =
  | "intended_use"
  | "data_width"
  | "depth"
  | "reset_style"
  | "write_when_full_with_read"
  | "clock_mhz"
  | "target_pdk";

export const RESET_STYLES = ["sync_active_low", "sync_active_high", "async_active_low"] as const;
export type ResetStyle = (typeof RESET_STYLES)[number];

export const PDK_OPTIONS = ["sky130hd", "gf180", "undecided"] as const;

/** One question at a time, in plain English (spec section 2). */
export const QUESTIONS: Question[] = [
  {
    key: "intended_use",
    label: "Intended use",
    prompt: "Is this for learning / a prototype, or do you plan to manufacture it commercially?",
    why: "It decides which checks are required before anything can be packaged for review.",
    ifUnknown: "We treat it as a prototype. Nothing will be described as ready for manufacturing.",
    criticality: "rtl",
    kind: "choice",
    options: [
      { value: "prototype", label: "Learning / prototype" },
      { value: "commercial", label: "Commercial manufacturing", hint: "This app only prepares files for expert review. It never submits to a foundry." },
    ],
    suggestion: { value: "prototype", rationale: "The open-source flow and public PDKs here are prototype-grade, so this is the safe starting point." },
  },
  {
    key: "data_width",
    label: "Data width",
    prompt: "How many bits wide is each value the chip stores? (8 bits = one byte)",
    why: "It sets the width of the data input and output pins and of every storage slot.",
    ifUnknown: "We can't generate the design until this is known or you accept a suggestion.",
    criticality: "rtl",
    unit: "bits",
    kind: "number",
    min: 1,
    max: 64,
    suggestion: { value: 8, rationale: "One byte is the most common width for a small buffer and keeps the design small." },
  },
  {
    key: "depth",
    label: "Depth",
    prompt: "How many values should it be able to hold at once?",
    why: "Each extra slot adds storage flip-flops, so this drives chip area. Must be a power of two (2, 4, 8 … 64).",
    ifUnknown: "We can't generate the design until this is known or you accept a suggestion.",
    criticality: "rtl",
    unit: "entries",
    kind: "number",
    min: 2,
    max: 64,
    suggestion: { value: 16, rationale: "16 entries is a small, fully verifiable size. Area grows linearly with depth." },
  },
  {
    key: "reset_style",
    label: "Reset behaviour",
    prompt: "How should the chip be reset to its empty starting state?",
    why: "Reset polarity and timing must match the system the block connects to.",
    ifUnknown: "We can't generate the design until this is known or you accept a suggestion.",
    criticality: "rtl",
    kind: "choice",
    options: [
      { value: "sync_active_low", label: "Synchronous, active-low (rst_n)", hint: "Reset is applied on a clock edge while rst_n = 0." },
      { value: "sync_active_high", label: "Synchronous, active-high (rst)" },
      { value: "async_active_low", label: "Asynchronous, active-low (rst_n)", hint: "Resets immediately, without waiting for the clock." },
    ],
    suggestion: { value: "sync_active_low", rationale: "Synchronous active-low reset is a common, timing-friendly convention for small blocks." },
  },
  {
    key: "write_when_full_with_read",
    label: "Write while full",
    prompt: "If the buffer is full and, in the same clock tick, one value is taken out and a new one arrives, should the new one be accepted?",
    why: "This corner case must be defined precisely, or the design and its tests can disagree.",
    ifUnknown: "We can't generate the design until this is known or you accept a suggestion.",
    criticality: "rtl",
    kind: "choice",
    options: [
      { value: true, label: "Yes, accept it (a slot is freed in the same tick)" },
      { value: false, label: "No, ignore it while full" },
    ],
    suggestion: { value: true, rationale: "Accepting keeps throughput at one item per cycle when producer and consumer run together." },
  },
  {
    key: "clock_mhz",
    label: "Clock frequency",
    prompt: "How fast is the clock that drives the chip, in MHz?",
    why: "It becomes the timing constraint (SDC) used for layout and timing analysis.",
    ifUnknown: "The design and its tests can still run, but layout and timing sign-off stay blocked (TIMING_CONSTRAINTS_INCOMPLETE).",
    criticality: "physical",
    unit: "MHz",
    kind: "number",
    min: 1,
    max: 500,
    suggestion: { value: 50, rationale: "50 MHz is a conservative target for SKY130/GF180 standard cells in a small block." },
  },
  {
    key: "target_pdk",
    label: "Target technology",
    prompt: "Which manufacturing technology (PDK) should the layout target?",
    why: "Layout, timing libraries and design-rule checks are all specific to one process.",
    ifUnknown: "RTL work continues. Physical implementation stays blocked until a PDK is confirmed.",
    criticality: "physical",
    kind: "choice",
    options: [
      { value: "sky130hd", label: "SkyWater SKY130 (sky130hd cells, 130 nm)", hint: "Public PDK, published as an experimental preview. Not production-qualified." },
      { value: "gf180", label: "GlobalFoundries GF180MCU (180 nm)", hint: "Public PDK, published as an experimental preview." },
      { value: "undecided", label: "Not decided yet" },
    ],
    suggestion: { value: "sky130hd", rationale: "SKY130 with OpenROAD Flow Scripts is the primary flow this product targets first." },
  },
];

export const QUESTION_BY_KEY = Object.fromEntries(QUESTIONS.map((q) => [q.key, q])) as Record<FieldKey, Question>;

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
}

/** Validate a candidate value for a field; returns an error message or null. */
export function validateValue(key: FieldKey, value: unknown): string | null {
  const q = QUESTION_BY_KEY[key];
  if (!q) return "unknown field";
  if (q.kind === "number") {
    const n = Number(value);
    if (!Number.isInteger(n)) return `${q.label} must be a whole number`;
    if (n < (q.min ?? -Infinity) || n > (q.max ?? Infinity)) return `${q.label} must be between ${q.min} and ${q.max}`;
    if (key === "depth" && !isPowerOfTwo(n)) return "Depth must be a power of two (2, 4, 8, 16, 32 or 64); larger sizes are outside the formally verified range of this release";
    return null;
  }
  if (!q.options!.some((o) => o.value === value)) return `${q.label} must be one of: ${q.options!.map((o) => o.label).join(", ")}`;
  return null;
}

export function normaliseValue(key: FieldKey, value: unknown): string | number | boolean {
  const q = QUESTION_BY_KEY[key];
  if (q.kind === "number") return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value as string | boolean;
}

export function emptyFields(): SpecField[] {
  return QUESTIONS.map((q) => ({
    key: q.key,
    value: null,
    unit: q.unit,
    source: "tool-derived" as FieldSource,
    status: "unknown" as FieldStatus,
    rationale: "Not provided yet.",
    revision: 1,
  }));
}

export function fieldMap(fields: SpecField[]): Record<string, SpecField> {
  return Object.fromEntries(fields.map((f) => [f.key, f]));
}

/** The next question the user has not answered yet ("Not sure" counts as an answer). */
export function nextQuestion(answered: string[]): Question | null {
  return QUESTIONS.find((q) => !answered.includes(q.key)) ?? null;
}

export interface ApprovalCheck {
  canApprove: boolean;
  blockers: string[];
  proposalsNeedingAcceptance: string[];
  physicalUnknowns: string[];
}

export function checkApproval(fields: SpecField[], accepted: string[]): ApprovalCheck {
  const map = fieldMap(fields);
  const blockers: string[] = [];
  const proposals: string[] = [];
  const physicalUnknowns: string[] = [];
  for (const q of QUESTIONS) {
    const f = map[q.key];
    const unknown = !f || f.status === "unknown" || f.value === null || (q.key === "target_pdk" && f.value === "undecided");
    if (q.criticality === "rtl") {
      if (unknown) blockers.push(`${q.label} is unknown`);
      else if (f.status === "proposed") {
        proposals.push(q.key);
        if (!accepted.includes(q.key)) blockers.push(`${q.label} is an AI proposal that you have not accepted`);
      }
    } else if (q.criticality === "physical") {
      if (unknown) physicalUnknowns.push(q.key);
      else if (f.status === "proposed") {
        proposals.push(q.key);
        if (!accepted.includes(q.key)) physicalUnknowns.push(q.key);
      }
    }
  }
  return { canApprove: blockers.length === 0, blockers, proposalsNeedingAcceptance: proposals, physicalUnknowns };
}

export interface FifoConfig {
  WIDTH: number;
  DEPTH: number;
  RESET: ResetStyle;
  ALLOW_WRITE_WHEN_FULL_WITH_READ: boolean;
}

export function fifoConfig(fields: SpecField[]): FifoConfig {
  const m = fieldMap(fields);
  return {
    WIDTH: Number(m.data_width.value),
    DEPTH: Number(m.depth.value),
    RESET: m.reset_style.value as ResetStyle,
    ALLOW_WRITE_WHEN_FULL_WITH_READ: Boolean(m.write_when_full_with_read.value),
  };
}

function reqStatus(fields: SpecField[], keys: string[]): FieldStatus {
  const m = fieldMap(fields);
  const statuses = keys.map((k) => m[k]?.status ?? "unknown");
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("proposed")) return "proposed";
  return "confirmed";
}

export function buildSpec(projectName: string, revision: number, fields: SpecField[], accepted: string[]): DesignSpec {
  const m = fieldMap(fields);
  const v = (k: FieldKey) => m[k]?.value;
  const width = v("data_width") ?? "UNCONFIRMED";
  const depth = v("depth") ?? "UNCONFIRMED";
  const reset = (v("reset_style") as ResetStyle | null) ?? "sync_active_low";
  const rstName = reset.endsWith("active_low") ? "rst_n" : "rst";
  const allowRw = v("write_when_full_with_read");
  const clock = v("clock_mhz");
  const pdk = v("target_pdk");
  const pdkKnown = pdk && pdk !== "undecided";
  const S = (...keys: string[]) => reqStatus(fields, keys);
  const requirements: Requirement[] = [
    { id: "REQ-FUNC-001", title: "Preserve accepted data order", statement: "Accepted items are read out unchanged, in the same order they were written.", priority: "must", status: S("data_width", "depth"), verification_method: ["simulation", "formal"], depends_on: ["data_width", "depth"] },
    { id: "REQ-FUNC-002", title: "Report occupancy", statement: `The count output always equals the number of stored items, between 0 and ${depth}.`, priority: "must", status: S("depth"), verification_method: ["simulation", "formal"], depends_on: ["depth"] },
    { id: "REQ-FUNC-003", title: "Full flag and overflow", statement: `full is 1 exactly when ${depth} items are stored; a write while full without a same-cycle read is ignored.`, priority: "must", status: S("depth"), verification_method: ["simulation", "formal"], depends_on: ["depth"] },
    { id: "REQ-FUNC-004", title: "Empty flag and underflow", statement: "empty is 1 exactly when no items are stored; a read while empty is ignored.", priority: "must", status: S("depth"), verification_method: ["simulation", "formal"], depends_on: ["depth"] },
    { id: "REQ-FUNC-005", title: "Same-cycle read and write", statement: `When empty, only the write is accepted. When partly full, both are accepted. When full, the write is ${allowRw === false ? "ignored" : "accepted"} because the read frees a slot.`, priority: "must", status: S("write_when_full_with_read"), verification_method: ["simulation", "formal"], depends_on: ["write_when_full_with_read"] },
    { id: "REQ-RST-001", title: "Reset state", statement: `While ${rstName} is ${reset.endsWith("active_low") ? "0" : "1"} (${reset.startsWith("async") ? "asynchronous" : "sampled on the clock edge"}), the FIFO becomes empty: empty=1, full=0, count=0.`, priority: "must", status: S("reset_style"), verification_method: ["simulation", "formal"], depends_on: ["reset_style"] },
    { id: "REQ-IF-001", title: "Interface contract", statement: `${width}-bit data ports, ${depth} entries, first-word-fall-through read (rd_data shows the oldest item while empty=0).`, priority: "must", status: S("data_width", "depth"), verification_method: ["lint", "simulation"], depends_on: ["data_width", "depth"] },
    { id: "REQ-CLK-001", title: "Clock frequency", statement: clock ? `Single clock domain at ${clock} MHz (period ${(1000 / Number(clock)).toFixed(3)} ns).` : "Single clock domain. Frequency UNCONFIRMED.", priority: "must", status: S("clock_mhz"), verification_method: ["sta"], depends_on: ["clock_mhz"] },
    { id: "REQ-TECH-001", title: "Target technology", statement: pdkKnown ? `Implement with OpenROAD Flow Scripts on ${pdk}.` : "Target PDK UNCONFIRMED.", priority: "must", status: pdkKnown ? S("target_pdk") : "unknown", verification_method: ["physical"], depends_on: ["target_pdk"] },
  ];
  const cw = typeof depth === "number" ? `${Math.ceil(Math.log2(depth + 1))}` : "clog2(DEPTH+1)";
  const interfaces = [
    { name: "clk", direction: "input" as const, width: "1", description: "Clock. All state changes on the rising edge." },
    { name: rstName, direction: "input" as const, width: "1", description: `Reset, ${reset.replace(/_/g, " ")}.` },
    { name: "wr_en", direction: "input" as const, width: "1", description: "Request to store wr_data this cycle." },
    { name: "wr_data", direction: "input" as const, width: String(width), description: "Value to store." },
    { name: "full", direction: "output" as const, width: "1", description: "1 when no free slot is left." },
    { name: "rd_en", direction: "input" as const, width: "1", description: "Request to remove the oldest value this cycle." },
    { name: "rd_data", direction: "output" as const, width: String(width), description: "Oldest stored value. Meaningful only while empty = 0." },
    { name: "empty", direction: "output" as const, width: "1", description: "1 when nothing is stored." },
    { name: "count", direction: "output" as const, width: cw, description: "Number of stored values." },
  ];
  return {
    schema_version: "1.0",
    project: { name: projectName, revision, intended_use: String(v("intended_use") ?? "UNCONFIRMED"), top_module: "sync_fifo", hdl: "SystemVerilog" },
    target: { flow: "openroad-flow-scripts", pdk: pdkKnown ? String(pdk) : "UNCONFIRMED", pdk_variant: pdkKnown ? (pdk === "sky130hd" ? "sky130A / sky130_fd_sc_hd (UNVERIFIED on this worker)" : "gf180mcuD (UNVERIFIED on this worker)") : "UNCONFIRMED" },
    parameters: typeof width === "number" && typeof depth === "number" ? { WIDTH: width, DEPTH: depth } : {},
    requirements,
    interfaces,
    clocks: [{ name: "clk", frequency_mhz: typeof clock === "number" ? clock : null, status: m.clock_mhz?.status ?? "unknown" }],
    resets: [{ name: rstName, polarity: reset.endsWith("active_low") ? "active_low" : "active_high", synchrony: reset.startsWith("async") ? "async" : "sync" }],
    constraints: {
      timing: typeof clock === "number" ? `create_clock period ${(1000 / clock).toFixed(3)} ns (draft SDC, needs approval)` : "UNCONFIRMED",
      area: "UNCONFIRMED (no target given; synthesis reports an estimate)",
      power: "UNCONFIRMED (no power analysis on this flow)",
    },
    out_of_scope: [
      "Multiple clock domains / clock-domain crossing",
      "Registered (non-fall-through) read port",
      "Almost-full / almost-empty thresholds",
      "SRAM macro storage (storage is built from flip-flops)",
      "DFT / scan insertion",
      "I/O pads, pad ring, packaging",
    ],
    assumptions: fields
      .filter((f) => f.source === "ai-proposed" && f.value !== null)
      .map((f) => ({ field: f.key, value: String(f.value), source: f.source, accepted: accepted.includes(f.key) })),
    open_questions: QUESTIONS.filter((q) => {
      const f = m[q.key];
      return !f || f.status === "unknown" || f.value === null || f.value === "undecided";
    }).map((q) => ({ field: q.key, question: q.prompt, blocks: q.criticality === "rtl" ? ["rtl", "verification", "physical"] : q.criticality === "physical" ? ["physical", "sta"] : [] })),
    fields,
  };
}
