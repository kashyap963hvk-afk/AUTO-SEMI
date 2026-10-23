/**
 * One tough project driven end to end through the real UI for the demo video:
 * 32 x 32-bit FIFO, asynchronous reset, 200 MHz, SKY130 -> verified RTL -> GDSII -> release.
 * Captions that quote numbers read them from the app's own API at recording time.
 */
import type { Page } from "playwright-core";
import type { Hooks } from "./goldenPath";

export interface DemoHooks extends Hooks {
  waitingFast: (on: boolean, factor: number) => void;
}

export interface ToughResult {
  physical: Record<string, unknown> & { checks: Record<string, string> };
  physicalSeconds: number;
  physicalMode: string;
  simCaught: string;
  simFinal: string;
}

export async function toughProject(page: Page, base: string, h: DemoHooks): Promise<ToughResult> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const click = async (text: string | RegExp) => {
    const el = page.getByRole("button", { name: text }).first();
    await el.scrollIntoViewIfNeeded();
    await pause(500);
    await el.click();
  };
  const scrollTo = async (y: number) => {
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "smooth" }), y);
    await pause(900);
  };
  const overview = async () =>
    page.evaluate(async () => {
      const id = location.pathname.split("/").pop();
      return (await fetch(`/api/projects/${id}`)).json();
    });

  await page.goto(base);
  await page.waitForSelector("text=Describe the chip you need.");
  await h.caption("One tough project, start to finish: plain English → verified RTL → GDSII layout. Real tools, real numbers.");
  await pause(3000);
  await page.click("#desc");
  await page.keyboard.type("I need a FIFO that stores 32 values of 32 bits each between a DMA engine and a CPU, with an asynchronous active-low reset, running at 200 MHz on SKY130. It's a prototype.", { delay: 18 });
  await page.click("#name");
  await page.keyboard.type("DMA FIFO 32x32 @ 200 MHz", { delay: 20 });
  await pause(600);
  await click("Start design");
  await page.waitForSelector(".question");
  await h.caption("Every value it extracted quotes my words, and stays a proposal until I confirm it.");
  await pause(4000);
  for (let i = 0; i < 10; i++) {
    if (await page.locator("text=All questions answered").count()) break;
    const q = (await page.locator(".question h3").textContent().catch(() => "")) ?? "";
    if (/full and/.test(q)) await h.caption("A corner case I never mentioned. It asks instead of guessing, and its suggestion is labelled an AI proposal.");
    if (await page.getByRole("button", { name: "Yes, that's right" }).count()) await click("Yes, that's right");
    else await click("Suggest one for me");
    await page.waitForLoadState("networkidle");
    await pause(1000);
  }
  await click("Generate specification for review");
  await page.waitForSelector("text=Review and approve the specification");
  await h.caption("Versioned spec. Nothing is a requirement until a human approves it.");
  await pause(3000);
  for (const box of await page.locator("text=Accept proposal").all()) {
    await box.scrollIntoViewIfNeeded();
    await box.click();
    await pause(400);
  }
  await click("Approve specification");
  await page.waitForSelector("text=Propose architecture");
  await click("Propose architecture");
  await page.waitForSelector("text=Decisions for your review");
  await h.caption("Architecture: 1,024-bit flip-flop storage, write/read control, occupancy counter.");
  await pause(3500);
  await click("Approve architecture");
  await page.waitForSelector("text=Generate RTL");

  await h.caption("Stress test: I plant a real bug. The full flag fires one entry early.");
  await page.locator("text=Demo: inject a known defect").click();
  await pause(1500);
  await click(/^Generate RTL$/);
  await page.waitForSelector("text=deliberately injected defect");
  await pause(1200);
  await click("Run checks →");
  await page.waitForSelector("text=Verification Center");
  await h.caption("Real tools: Verilator lint, then a cocotb + Icarus regression with a 2,000-cycle random scoreboard.");
  h.waitingFast(true, 6);
  await click("Run all checks");
  await page.waitForSelector("text=Explain this error");
  h.waitingFast(false, 6);
  const sim0 = (await overview()).latestRuns.simulation.result;
  const simCaught = `${sim0.tests.filter((t: { status: string }) => t.status === "FAIL" || t.status === "ERROR").length} of ${sim0.tests.length}`;
  await h.caption(`Caught: simulation fails ${simCaught} tests. Later checks don't run, and nothing turns green.`);
  await pause(3500);
  await click("Explain this error");
  await page.waitForSelector("text=Plain-English diagnosis");
  await pause(3000);
  await click("Propose a fix");
  await page.waitForSelector("text=Apply fix as new revision");
  await page.locator("text=Bounded repair").scrollIntoViewIfNeeded();
  await h.caption("A one-line fix as a NEW revision. Tests are untouched, and the failed revision is kept on record.");
  await pause(4000);
  h.waitingFast(true, 6);
  await click("Apply fix as new revision and re-run");
  await h.caption("Re-running everything: lint → simulation → formal proof (SymbiYosys + z3) → synthesis (Yosys).");
  await page.waitForSelector("text=Prototype checks passed: lint");
  h.waitingFast(false, 6);
  await scrollTo(0);
  const ov1 = await overview();
  const syn = ov1.latestRuns.synthesis.result.metrics;
  const sim1 = ov1.latestRuns.simulation.result;
  const simFinal = `${sim1.tests.filter((t: { status: string }) => t.status === "PASS").length}/${sim1.tests.length}`;
  await h.caption(`All green on revision 2: ${simFinal} tests, formal ${ov1.latestRuns.formal.result.formal_status}, ${syn.cells_total} generic cells, ${syn.latches} latches.`);
  await pause(4500);

  await page.locator(".rail button", { hasText: "Physical design" }).click();
  await page.waitForSelector("text=Physical Design Center");
  await h.caption("Now the part most AI demos skip: physical design. A human approves the 200 MHz timing constraints first.");
  await pause(2500);
  await page.fill("input[placeholder='Approver name']", "A. Engineer");
  await click("Approve these constraints");
  await page.waitForSelector("text=Approved by A. Engineer");
  await pause(1000);
  h.waitingFast(true, 30);
  const pdStart = Date.now();
  await click("Run physical design");
  await h.caption("OpenROAD Flow Scripts on SKY130: synthesis, floorplan, power grid, placement, clock tree, routing, GDSII, then KLayout DRC + LVS.");
  await page.waitForSelector("text=Sign-off checks (as run)", { timeout: 3_600_000 });
  h.waitingFast(false, 30);
  const physicalSeconds = Math.round((Date.now() - pdStart) / 1000);
  const ov2 = await overview();
  const pr = ov2.latestRuns.physical.result;
  const pm = pr.metrics;
  const dur = Math.round(pr.duration_s);
  await h.caption(`That was a ${pr.execution.mode === "live-worker" ? "live" : pr.execution.mode} run: ${Math.floor(dur / 60)} min ${dur % 60} s of real compute, shown 30× faster.`);
  await pause(3500);
  await page.locator("text=Routed layout (OpenROAD)").scrollIntoViewIfNeeded();
  await pause(800);
  await h.caption(`Real GDSII: ${Math.round(pm.design_area_um2).toLocaleString()} µm² of cells, ${pm.utilization_pct}% utilization. LVS ${pm.lvs === "MATCH" ? "matches" : pm.lvs}, ${pm.klayout_drc_violations} DRC markers (${pm.klayout_drc_scope}), ${pm.antenna_net_violations} antenna violations.`);
  await pause(5500);
  await h.caption(`Timing met at 200 MHz with only +${pm.worst_slack_ns} ns of slack, at the typical corner only. At the slow corner it might not hold.`);
  await pause(5500);
  const NAMES: Record<string, string> = { klayout_drc_feol: "FEOL DRC", multi_corner_sta: "slow/fast-corner STA", equivalence_check: "the netlist-vs-RTL equivalence check" };
  const notRun = Object.entries(pm.checks as Record<string, string>).filter(([, v]) => v === "NOT_RUN").map(([k]) => NAMES[k] ?? k);
  const gaps = notRun.length ? notRun.join(", ") : "nothing";
  await h.caption(`Not run, and shown as NOT RUN: ${gaps}. A pass is only shown where a tool reported one.`);
  await pause(5000);

  await page.locator(".rail button", { hasText: "Release" }).click();
  await page.waitForSelector("text=Release Center");
  await page.locator("text=Open-PDK physical prototype").click();
  await pause(1200);
  await click("Create release candidate");
  await page.waitForSelector("text=Waiting for human review");
  await page.locator("text=I accept these open").scrollIntoViewIfNeeded();
  await h.caption(`Sign-off requires a qualified human, who has to accept each gap by name (${gaps}).`);
  await page.fill("input[placeholder='Reviewer name']", "R. Reviewer");
  await page.fill("input[placeholder^='Role']", "ASIC design engineer");
  await page.locator("text=I am a qualified human reviewer").click();
  await page.locator("text=I accept these open").click();
  await pause(3500);
  await click("Sign off release candidate");
  await page.waitForSelector("text=Export release package");
  await Promise.all([page.waitForEvent("download"), click(/Export release package/)]);
  await page.waitForSelector("text=Integrity verified");
  await page.locator("text=Integrity verified").scrollIntoViewIfNeeded();
  await h.caption("Package with GDSII, netlist, reports and a SHA-256 manifest. Verified on export, and marked 'not submitted' to any foundry.");
  await pause(4500);
  await h.caption(null);
  return { physical: pm, physicalSeconds, physicalMode: pr.execution.mode, simCaught, simFinal };
}
