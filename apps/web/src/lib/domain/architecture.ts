import type { DesignSpec } from "./spec";

export interface Architecture {
  schema_version: "1.0";
  spec_revision: number;
  template: string;
  blocks: { id: string; name: string; purpose: string }[];
  connections: { from: string; to: string; signal: string }[];
  parameters: { name: string; value: number; reason: string }[];
  handshake_rules: string[];
  decisions: { id: string; decision: string; chosen: string; alternatives: string[]; rationale: string; needs_approval: boolean }[];
  risks: { area: "timing" | "area" | "verification" | "integration"; risk: string; mitigation: string }[];
  estimates: { storage_bits: number; note: string };
  verification_strategy: string[];
  clock_reset: string;
}

export function proposeArchitecture(spec: DesignSpec, specRevision: number, template: string): Architecture {
  const W = spec.parameters.WIDTH;
  const D = spec.parameters.DEPTH;
  const reset = spec.resets[0];
  return {
    schema_version: "1.0",
    spec_revision: specRevision,
    template,
    blocks: [
      { id: "wr", name: "Write control", purpose: "Accepts wr_data when wr_en is high and a slot is free, and advances the write pointer." },
      { id: "mem", name: `Storage array (${D} × ${W} bits)`, purpose: "Holds the queued values in flip-flops. No SRAM macro is used." },
      { id: "rd", name: "Read control", purpose: "Shows the oldest value on rd_data and advances the read pointer when rd_en removes it." },
      { id: "cnt", name: "Occupancy counter", purpose: "Tracks how many values are stored and drives full, empty and count." },
    ],
    connections: [
      { from: "wr", to: "mem", signal: "wr_ptr, wr_data" },
      { from: "mem", to: "rd", signal: "mem[rd_ptr]" },
      { from: "wr", to: "cnt", signal: "write accepted" },
      { from: "rd", to: "cnt", signal: "read accepted" },
      { from: "cnt", to: "wr", signal: "full" },
      { from: "cnt", to: "rd", signal: "empty" },
    ],
    parameters: [
      { name: "WIDTH", value: W, reason: "From the approved data-width requirement." },
      { name: "DEPTH", value: D, reason: "From the approved depth requirement; a power of two, so pointers wrap naturally." },
    ],
    handshake_rules: spec.requirements.filter((r) => r.id.startsWith("REQ-FUNC")).map((r) => `${r.id}: ${r.statement}`),
    decisions: [
      {
        id: "ARCH-001",
        decision: "Read port style",
        chosen: "First-word-fall-through (rd_data shows the head item combinationally)",
        alternatives: ["Registered read (data appears one cycle after rd_en)"],
        rationale: "Simplest contract for a consumer: data is visible before it is popped. Costs a read-mux path from storage to output.",
        needs_approval: true,
      },
      {
        id: "ARCH-002",
        decision: "Occupancy tracking",
        chosen: "Explicit count register (clog2(DEPTH+1) bits)",
        alternatives: ["Extra pointer wrap bit, with flags derived from pointer comparison"],
        rationale: "Gives the required count output directly and keeps the full/empty logic easy to verify formally.",
        needs_approval: true,
      },
      {
        id: "ARCH-003",
        decision: "Storage technology",
        chosen: "Flip-flop array inferred from RTL",
        alternatives: ["Foundry SRAM macro (requires approved macro views; out of scope)"],
        rationale: `${W * D} bits is small enough for flip-flops, and no third-party IP is needed.`,
        needs_approval: false,
      },
    ],
    risks: [
      { area: "area", risk: `Storage costs about ${W * D} flip-flops plus a ${D}:1 read multiplexer per bit.`, mitigation: "Synthesis reports the generic cell count. Revisit depth if area matters." },
      { area: "timing", risk: "The read multiplexer and the count compare are the longest combinational paths.", mitigation: "Checked by STA once a clock is approved and physical design runs." },
      { area: "verification", risk: "Simultaneous read/write at full and empty is the classic bug source.", mitigation: "Directed tests, seeded random scoreboard, and formal proofs cover REQ-FUNC-005." },
      { area: "integration", risk: "rd_data is undefined while empty.", mitigation: "Documented in the interface contract. Consumers must gate on empty." },
    ],
    estimates: { storage_bits: W * D, note: "Estimate from parameters, not a tool result." },
    verification_strategy: [
      "Lint: Verilator -Wall plus Yosys elaboration checks, with no unapproved waivers.",
      "Simulation: cocotb regression (7 tests: directed edge cases plus 2000-cycle seeded random scoreboard) on Icarus Verilog.",
      "Formal: SymbiYosys k-induction proof of occupancy, flags, reset state and data ordering, plus cover checks for vacuity.",
      "Synthesis: Yosys generic mapping, with checks for latches and unmapped cells.",
      "Physical: OpenROAD Flow Scripts on the confirmed PDK, only once approved timing constraints exist.",
    ],
    clock_reset: `Single clock domain (clk). Reset ${reset.name}, ${reset.polarity.replace("_", "-")}, ${reset.synchrony}hronous.`,
  };
}
