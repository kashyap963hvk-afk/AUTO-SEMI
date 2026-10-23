import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.DEVIN_DB = "memory";
process.env.DEVIN_MIGRATIONS_DIR = path.resolve(__dirname, "../../../migrations");
process.env.DEVIN_EVIDENCE_DIR = path.resolve(__dirname, "../../../evidence");
delete process.env.WORKER_URL;

import { getDb, resetDbForTests } from "../store/db";
import * as svc from "../services/project";
import { approveRelease, createReleaseCandidate, exportRelease, verifyPackage } from "../services/release";
import { getProject, listAudit } from "../store/repo";
import { strToU8, unzipSync, zipSync } from "fflate";

const alice = { id: "alice" };
const mallory = { id: "mallory" };

beforeEach(async () => {
  resetDbForTests();
  const db = await getDb();
  await db.query("INSERT INTO users (id, token_hash, display_name) VALUES ('alice','ha','Alice'), ('mallory','hm','Mallory')");
});

async function toApprovedArchitecture(description = "A FIFO buffer that holds 16 bytes, 50 MHz clock, SKY130, for a class project.") {
  let p = await svc.createProject(alice, { name: "UART RX FIFO", description });
  expect(p.state).toBe("REQUIREMENTS_IN_PROGRESS");
  for (;;) {
    const q = svc.interviewState(p).question;
    if (!q) break;
    const f = p.data.fields.find((x) => x.key === q.key)!;
    p = await svc.answerQuestion(alice, p.id, f.status === "proposed" ? { key: q.key, action: "confirm" } : { key: q.key, action: "suggest" });
  }
  p = await svc.generateSpecification(alice, p.id);
  expect(p.state).toBe("SPEC_REVIEW_REQUIRED");
  return p;
}

describe("golden path (spec section 40) with real recorded tool evidence", () => {
  it("refuses RTL before approval, then runs requirements to release export", async () => {
    let p = await toApprovedArchitecture();
    // Acceptance test 2: no RTL before the gate.
    await expect(svc.generateRtlRevision(alice, p.id, {})).rejects.toThrow();
    // Acceptance test 1: proposals must be accepted explicitly.
    await expect(svc.approveSpecification(alice, p.id, { revision: p.data.spec_revision!, accepted: [], acknowledge_physical_unknowns: true })).rejects.toThrow(/not accepted/);
    const proposals = p.data.fields.filter((f) => f.status === "proposed").map((f) => f.key);
    p = await svc.approveSpecification(alice, p.id, { revision: p.data.spec_revision!, accepted: proposals, acknowledge_physical_unknowns: true });
    p = await svc.generateArchitecture(alice, p.id);
    p = await svc.approveArchitecture(alice, p.id, { revision: p.data.architecture_revision! });
    p = await svc.generateRtlRevision(alice, p.id, {});
    const events: string[] = [];
    p = await svc.runChecks(alice, p.id, { onEvent: (e) => events.push(`${e.type}:${"stage" in e ? e.stage : ""}`) });
    expect(p.state).toBe("PROTOTYPE_CHECKS_PASSED");
    const latest = await svc.latestRuns(p.id);
    expect(latest.lint!.result.execution.mode).toBe("recorded");
    expect(latest.simulation!.result.tests).toHaveLength(7);
    expect(latest.formal!.result.formal_status).toBe("PROVED");
    expect(events.filter((e) => e.startsWith("stage_finished"))).toHaveLength(4);

    // Physical design is honestly blocked (no approved SDC, no ORFS).
    p = await svc.runChecks(alice, p.id, { only: "physical" });
    expect(p.state).toBe("BLOCKED_MISSING_CONSTRAINTS");

    const rc = await createReleaseCandidate(alice, p.id);
    expect(rc.status).toBe("review_required");
    await expect(approveRelease(alice, rc.id, { approver_name: "R", approver_role: "Eng", qualified_reviewer: false, accepted_open_issues: [] })).rejects.toThrow(/qualified/);
    const open = rc.checklist.filter((i) => i.requirement !== "required" && i.status !== "pass").map((i) => i.id);
    await approveRelease(alice, rc.id, { approver_name: "R. Reviewer", approver_role: "Design engineer", qualified_reviewer: true, accepted_open_issues: open });
    const a = await exportRelease(alice, rc.id);
    const b = await exportRelease(alice, rc.id);
    // Phase 6 exit criterion: identical inputs give the identical manifest and archive.
    expect(a.manifest_sha256).toBe(b.manifest_sha256);
    expect(Buffer.from(a.zip).equals(Buffer.from(b.zip))).toBe(true);
    expect(verifyPackage(a.zip).ok).toBe(true);
    // Acceptance test 12: tampering is detected.
    const entries = unzipSync(a.zip);
    entries["rtl/sync_fifo.sv"] = strToU8(new TextDecoder().decode(entries["rtl/sync_fifo.sv"]).replace("DEPTH_C);", "DEPTH_C - 1);"));
    const tampered = verifyPackage(zipSync(entries));
    expect(tampered.ok).toBe(false);
    expect(tampered.problems).toContain("checksum mismatch: rtl/sync_fifo.sv");
    const readme = new TextDecoder().decode(entries["README_FIRST.txt"]);
    expect(readme).toMatch(/NOT been submitted/);

    // Acceptance test 13: another user cannot see or touch the project.
    await expect(getProject(mallory.id, p.id)).rejects.toThrow(/not found/);
    await expect(svc.runChecks(mallory, p.id)).rejects.toThrow(/not found/);
    await expect(exportRelease(mallory, rc.id)).rejects.toThrow(/not found/);
    expect((await listAudit(p.id)).some((e) => e.action === "release.exported")).toBe(true);
  }, 120_000);

  it("catches an injected defect, explains it, repairs within the limit, and preserves revisions", async () => {
    let p = await toApprovedArchitecture();
    p = await svc.approveSpecification(alice, p.id, { revision: p.data.spec_revision!, accepted: p.data.fields.filter((f) => f.status === "proposed").map((f) => f.key), acknowledge_physical_unknowns: true });
    p = await svc.generateArchitecture(alice, p.id);
    p = await svc.approveArchitecture(alice, p.id, { revision: p.data.architecture_revision! });
    p = await svc.generateRtlRevision(alice, p.id, { inject_defect: "full_off_by_one" });
    p = await svc.runChecks(alice, p.id);
    expect(p.state).toBe("REPAIR_REQUIRED");
    const latest = await svc.latestRuns(p.id);
    expect(latest.simulation!.result.status).toBe("FAIL");
    expect(latest.formal).toBeUndefined(); // sequence stops at the first failing stage
    const why = await svc.explainRun(alice, p.id, latest.simulation!.id);
    expect(why.mock).toBe(true);
    expect(why.likely_cause).toMatch(/full flag/i);
    // Release is refused with a failing required check (acceptance test 11).
    const rc = await createReleaseCandidate(alice, p.id);
    expect(rc.status).toBe("blocked");
    const proposal = await svc.proposeRepair(alice, p.id);
    expect(proposal.available).toBe(true);
    if (!proposal.available) return;
    expect(proposal.diff).toContain("-  assign full    = (count_q == DEPTH_C - 1);");
    p = await svc.applyRepair(alice, p.id, { proposal_hash: proposal.proposal_hash });
    expect(p.data.source_revision).toBe(2);
    p = await svc.runChecks(alice, p.id);
    expect(p.state).toBe("PROTOTYPE_CHECKS_PASSED");
    const runs = await (await import("../store/repo")).listRuns(p.id);
    expect(runs.filter((r) => r.source_revision === 1).length).toBeGreaterThan(0); // failed attempt preserved
  }, 120_000);

  it("stops the repair loop at the configured limit (acceptance test 9)", async () => {
    let p = await toApprovedArchitecture();
    p = await svc.approveSpecification(alice, p.id, { revision: p.data.spec_revision!, accepted: p.data.fields.filter((f) => f.status === "proposed").map((f) => f.key), acknowledge_physical_unknowns: true });
    p = await svc.generateArchitecture(alice, p.id);
    p = await svc.approveArchitecture(alice, p.id, { revision: p.data.architecture_revision! });
    p = await svc.generateRtlRevision(alice, p.id, { inject_defect: "full_off_by_one" });
    p = await svc.runChecks(alice, p.id);
    const db = await getDb();
    const row = await getProject(alice.id, p.id);
    row.data.repair_rounds = row.data.repair_limit;
    await db.query("UPDATE projects SET data = $1::jsonb WHERE id = $2", [row.data, p.id]);
    const proposal = await svc.proposeRepair(alice, p.id);
    expect(proposal.available).toBe(false);
    if (!proposal.available) expect(proposal.reason).toMatch(/limit reached/);
  }, 120_000);

  it("reports tools as unavailable instead of fabricating results (acceptance tests 7, 15)", async () => {
    process.env.DEVIN_DISABLE_RECORDED = "1";
    process.env.DEVIN_DISABLE_WASM = "1";
    try {
      let p = await toApprovedArchitecture();
      p = await svc.approveSpecification(alice, p.id, { revision: p.data.spec_revision!, accepted: p.data.fields.filter((f) => f.status === "proposed").map((f) => f.key), acknowledge_physical_unknowns: true });
      p = await svc.generateArchitecture(alice, p.id);
      p = await svc.approveArchitecture(alice, p.id, { revision: p.data.architecture_revision! });
      p = await svc.generateRtlRevision(alice, p.id, {});
      p = await svc.runChecks(alice, p.id);
      expect(p.state).toBe("BLOCKED_TOOL_UNAVAILABLE");
      const lint = (await svc.latestRuns(p.id)).lint!.result;
      expect(lint.execution.mode).toBe("unavailable");
      expect(lint.steps).toEqual([]);
    } finally {
      delete process.env.DEVIN_DISABLE_RECORDED;
      delete process.env.DEVIN_DISABLE_WASM;
    }
  }, 120_000);

  it("runs real Yosys in-process (WASM) when no worker or recording matches", async () => {
    process.env.DEVIN_DISABLE_RECORDED = "1";
    try {
      const { wasmSynth, wasmLint } = await import("../eda/wasmYosys");
      const { buildJob } = await import("../eda/jobs");
      const { generateRtl, generateProps, generateFilelist } = await import("../design/fifoTemplate");
      const cfg = { WIDTH: 8, DEPTH: 4, RESET: "sync_active_low", ALLOW_WRITE_WHEN_FULL_WITH_READ: true } as const;
      const src = { "rtl/sync_fifo.sv": generateRtl(cfg), "formal/sync_fifo_props.svh": generateProps(cfg), "rtl/filelist.f": generateFilelist() };
      const synth = await wasmSynth(buildJob("synthesis", "w1", src, cfg));
      expect(synth.status).toBe("PASS");
      expect((synth.metrics as { cells_total: number }).cells_total).toBeGreaterThan(20);
      const lint = await wasmLint(buildJob("lint", "w2", src, cfg));
      expect(lint.status).toBe("BLOCKED_TOOL_UNAVAILABLE"); // Yosys passed, Verilator not available
      const broken = await wasmLint(buildJob("lint", "w3", { ...src, "rtl/sync_fifo.sv": src["rtl/sync_fifo.sv"].replace("endmodule", "") }, cfg));
      expect(broken.status).toBe("FAIL");
    } finally {
      delete process.env.DEVIN_DISABLE_RECORDED;
    }
  }, 120_000);
});
