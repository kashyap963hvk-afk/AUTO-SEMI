import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../hash";
import { generateProps, generateRtl } from "../design/fifoTemplate";
import { checkApproval, emptyFields, validateValue, buildSpec } from "../domain/fifo";
import { DesignSpec } from "../domain/spec";
import { STATES, TRANSITIONS, TransitionError, assertTransition, userStatus } from "../domain/workflow";
import { buildChecklist, blockers, resultLevel } from "../domain/release";
import { unifiedDiff } from "../diff";
import type { SpecField } from "../domain/spec";

const ROOT = path.resolve(__dirname, "../../../../..");
const DEFAULT = { WIDTH: 8, DEPTH: 16, RESET: "sync_active_low", ALLOW_WRITE_WHEN_FULL_WITH_READ: true } as const;

describe("canonical hashing", () => {
  it("matches the worker's canonical JSON byte for byte", () => {
    // Same fixture as worker/tests/test_parsers.py::test_canonical_hash_matches_web_fixture
    expect(canonicalJson({ b: [1, { z: "é", a: true }], a: null })).toBe('{"a":null,"b":[1,{"a":true,"z":"é"}]}');
  });
});

describe("RTL template", () => {
  it("reproduces the checked-in reference RTL and properties exactly", () => {
    expect(generateRtl(DEFAULT)).toBe(readFileSync(path.join(ROOT, "designs/sync_fifo/reference/sync_fifo.sv"), "utf8"));
    expect(generateProps(DEFAULT)).toBe(readFileSync(path.join(ROOT, "designs/sync_fifo/reference/sync_fifo_props.svh"), "utf8"));
  });
  it("is deterministic and parameter-dependent", () => {
    expect(generateRtl(DEFAULT)).toBe(generateRtl({ ...DEFAULT }));
    expect(generateRtl({ ...DEFAULT, RESET: "async_active_low" })).toContain("posedge clk or negedge rst_n");
    expect(generateRtl({ ...DEFAULT, RESET: "sync_active_high" })).toContain("input  wire                       rst,");
    expect(generateRtl({ ...DEFAULT, ALLOW_WRITE_WHEN_FULL_WITH_READ: false })).toContain("ALLOW_WRITE_WHEN_FULL_WITH_READ = 1'b0");
  });
  it("injects the demo defect only when asked", () => {
    expect(generateRtl(DEFAULT, ["full_off_by_one"])).toContain("count_q == DEPTH_C - 1");
    expect(generateRtl(DEFAULT)).not.toContain("DEPTH_C - 1");
  });
});

describe("workflow state machine", () => {
  it("rejects transitions that are not in the table", () => {
    expect(() => assertTransition("DRAFT", "RTL_LINTING")).toThrow(TransitionError);
    expect(() => assertTransition("REQUIREMENTS_IN_PROGRESS", "SPEC_APPROVED")).toThrow(TransitionError);
    expect(() => assertTransition("SPEC_REVIEW_REQUIRED", "SPEC_APPROVED")).not.toThrow();
  });
  it("has no path into SUBMITTED or PROVIDER_ACCEPTED (no authorised provider integration)", () => {
    for (const s of STATES) {
      if (s === "SUBMITTED") continue;
      expect(TRANSITIONS[s]).not.toContain("SUBMITTED");
    }
    const inbound = STATES.filter((s) => TRANSITIONS[s].includes("PROVIDER_ACCEPTED"));
    expect(inbound).toEqual(["SUBMITTED"]);
  });
  it("maps every state to a plain-language status", () => {
    for (const s of STATES) expect(userStatus(s).label).toBeTruthy();
  });
});

function answered(overrides: Partial<Record<string, Partial<SpecField>>> = {}): SpecField[] {
  const values: Record<string, unknown> = { intended_use: "prototype", data_width: 8, depth: 16, reset_style: "sync_active_low", write_when_full_with_read: true, clock_mhz: 50, target_pdk: "sky130hd" };
  return emptyFields().map((f) => ({ ...f, value: values[f.key] as never, source: "user-confirmed", status: "confirmed", ...(overrides[f.key] ?? {}) }));
}

describe("requirements and approval gate", () => {
  it("validates values", () => {
    expect(validateValue("depth", 12)).toMatch(/power of two/);
    expect(validateValue("depth", 128)).toMatch(/between/);
    expect(validateValue("data_width", 0)).toBeTruthy();
    expect(validateValue("reset_style", "sync_active_low")).toBeNull();
  });
  it("blocks approval while a critical field is unknown", () => {
    const c = checkApproval(answered({ depth: { value: null, status: "unknown", source: "tool-derived" } }), []);
    expect(c.canApprove).toBe(false);
    expect(c.blockers.join()).toMatch(/Depth is unknown/);
  });
  it("never lets an AI proposal become a requirement without explicit acceptance", () => {
    const fields = answered({ reset_style: { source: "ai-proposed", status: "proposed" } });
    expect(checkApproval(fields, []).canApprove).toBe(false);
    expect(checkApproval(fields, ["reset_style"]).canApprove).toBe(true);
  });
  it("allows unknown physical fields but reports them", () => {
    const c = checkApproval(answered({ clock_mhz: { value: null, status: "unknown" } }), []);
    expect(c.canApprove).toBe(true);
    expect(c.physicalUnknowns).toEqual(["clock_mhz"]);
  });
  it("builds a schema-valid spec and keeps placeholders UNCONFIRMED", () => {
    const spec = buildSpec("t", 1, answered({ clock_mhz: { value: null, status: "unknown" }, target_pdk: { value: "undecided" } }), []);
    expect(DesignSpec.safeParse(spec).success).toBe(true);
    expect(spec.constraints.timing).toBe("UNCONFIRMED");
    expect(spec.target.pdk).toBe("UNCONFIRMED");
    expect(spec.open_questions.map((q) => q.field)).toEqual(["clock_mhz", "target_pdk"]);
  });
});

describe("release policy", () => {
  const pass = (stage: string, rev = 1) => ({ source_revision: rev, result: { status: "PASS", summary: "ok", execution: { mode: "live-worker" }, formal_status: stage === "formal" ? "PROVED" : null } as never });
  const base = { specApproved: true, architectureApproved: true, sourceRevision: 1, constraintsApproved: false, clockKnown: true, pdkConfirmed: true, humanApproval: false };
  it("blocks the RTL release when a required check is missing, failed or stale", () => {
    const items = buildChecklist({ ...base, policy: "rtl-prototype", latestRuns: { lint: pass("lint"), simulation: pass("simulation"), formal: pass("formal", 0) } });
    const b = blockers(items).map((i) => `${i.id}:${i.status}`);
    expect(b).toContain("run.formal:stale");
    expect(b).toContain("run.synthesis:missing");
  });
  it("passes the RTL policy when all four checks pass on the current revision", () => {
    const items = buildChecklist({ ...base, policy: "rtl-prototype", latestRuns: { lint: pass("lint"), simulation: pass("simulation"), formal: pass("formal"), synthesis: pass("synthesis") } });
    expect(blockers(items)).toEqual([]);
    expect(blockers(items, true).map((i) => i.id)).toEqual(["human.signoff"]);
  });
  it("blocks the physical policy without approved constraints and a physical run", () => {
    const items = buildChecklist({ ...base, policy: "open-pdk-physical-prototype", latestRuns: { lint: pass("lint"), simulation: pass("simulation"), formal: pass("formal"), synthesis: pass("synthesis") } });
    expect(blockers(items).map((i) => i.id)).toEqual(["constraints.sdc", "run.physical"]);
  });
  it("a failed layout blocks the physical policy but is disclosed, not hidden, in an RTL-only package", () => {
    const physFail = { source_revision: 1, result: { status: "FAIL", summary: "failing checks: klayout_drc", execution: { mode: "live-worker" }, metrics: { checks: { klayout_drc: "FAIL", klayout_drc_feol: "PASS", multi_corner_sta: "NOT_RUN" } } } as never };
    const runs = { lint: pass("lint"), simulation: pass("simulation"), formal: pass("formal"), synthesis: pass("synthesis"), physical: physFail };
    const rtl = buildChecklist({ ...base, policy: "rtl-prototype", latestRuns: runs });
    expect(blockers(rtl)).toEqual([]);
    expect(rtl.find((i) => i.id === "run.physical")!.detail).toContain("reported FAIL: failing checks: klayout_drc");
    const phys = buildChecklist({ ...base, constraintsApproved: true, policy: "open-pdk-physical-prototype", latestRuns: runs });
    expect(blockers(phys).map((i) => `${i.id}:${i.status}`)).toEqual(["run.physical:fail"]);
    expect(phys.find((i) => i.id === "phys.feol_drc")!.status).toBe("pass");
    expect(phys.find((i) => i.id === "phys.multi_corner")!.status).toBe("missing");
  });
  it("lets a FAILED layout go to release review only through the checklist gate", () => {
    expect(() => assertTransition("FAILED", "RELEASE_REVIEW_REQUIRED")).not.toThrow();
    expect(() => assertTransition("FAILED", "PHYSICAL_DESIGN_RUNNING")).not.toThrow();
    expect(() => assertTransition("FAILED", "RELEASE_APPROVED")).toThrow(TransitionError);
  });
  it("computes honest result levels", () => {
    const lvl = resultLevel({ ...base, releaseApproved: false, latestRuns: { lint: pass("lint"), simulation: pass("simulation"), formal: pass("formal"), synthesis: pass("synthesis") } });
    expect(lvl.level).toBe(3);
  });
});

describe("diff", () => {
  it("shows a one-line change", () => {
    const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(d).toContain("-b");
    expect(d).toContain("+B");
  });
});
