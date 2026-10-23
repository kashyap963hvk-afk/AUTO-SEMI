/**
 * The golden path (spec section 40) driven through the real UI. Shared by the browser
 * E2E test and the demo-video recorder; hooks let the recorder add captions and
 * mark long tool waits.
 */
import type { Page } from "playwright-core";

export interface Hooks {
  slow: boolean;
  shot: (name: string) => Promise<void>;
  caption: (text: string | null) => Promise<void>;
  /** Marks the start/end of a wait on real tools (the recorder speeds these up and says so). */
  waiting: (on: boolean) => void;
}

export async function goldenPath(page: Page, base: string, h: Hooks): Promise<{ download: string }> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, h.slow ? ms : Math.min(ms, 150)));
  const clickText = async (text: string | RegExp) => {
    const el = page.getByRole("button", { name: text }).first();
    await el.scrollIntoViewIfNeeded();
    await pause(500);
    await el.click();
  };
  const type = async (selector: string, text: string) => {
    await page.click(selector);
    if (h.slow) await page.keyboard.type(text, { delay: 22 });
    else await page.fill(selector, text);
  };
  const smoothScroll = async (y: number) => {
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "smooth" }), y);
    await pause(900);
  };

  await page.goto(base);
  await page.waitForSelector("text=Describe the chip you need.");
  await h.caption("Describe the chip you need, in plain English. No VLSI vocabulary required.");
  await pause(2500);
  await h.shot("landing");
  await type("#desc", "I need a small buffer chip that holds 16 bytes for a UART receiver, running at 50 MHz on SKY130. It's for a class project.");
  await type("#name", "UART RX FIFO");
  await pause(700);
  await clickText("Start design");
  await page.waitForSelector(".question");
  await h.caption("The requirements analyst extracts only what you said. Each value quotes your words and stays a proposal until you confirm it.");
  await pause(4200);
  await h.shot("discovery");

  for (let i = 0; i < 10; i++) {
    if (await page.locator("text=All questions answered").count()) break;
    const q = await page.locator(".question h3").textContent().catch(() => "");
    if (q && /reset/.test(q)) await h.caption("Unknown technical details? Ask for a suggestion. It is labelled as an AI proposal, never silently made a requirement.");
    const confirm = page.getByRole("button", { name: "Yes, that's right" });
    if (await confirm.count()) await clickText("Yes, that's right");
    else await clickText("Suggest one for me");
    await page.waitForLoadState("networkidle");
    await pause(1100);
  }
  await h.shot("discovery-done");
  await clickText("Generate specification for review");
  await page.waitForSelector("text=Review and approve the specification");
  await h.caption("A versioned, typed specification. Every requirement shows where it came from: you, or an AI proposal waiting for approval.");
  await pause(3500);
  await h.shot("spec");
  await smoothScroll(250);
  for (const box of await page.locator("text=Accept proposal").all()) {
    await box.scrollIntoViewIfNeeded();
    await box.click();
    await pause(500);
  }
  const ack = page.locator("text=stay open");
  if (await ack.count()) await ack.click();
  await clickText("Approve specification");
  await page.waitForSelector("text=Propose architecture");
  await pause(800);
  await clickText("Propose architecture");
  await page.waitForSelector("text=Decisions for your review");
  await h.caption("Architecture proposal: block diagram, interface contract, design decisions with alternatives, and risks.");
  await pause(4000);
  await h.shot("architecture");
  await clickText("Approve architecture");
  await page.waitForSelector("text=Generate RTL");

  await h.caption("Stress test: plant a real bug in the RTL. The full flag fires one entry early. Will the checks catch it?");
  await page.locator("text=Demo: inject a known defect").click();
  await pause(1800);
  await clickText(/^Generate RTL$/);
  await page.waitForSelector("text=deliberately injected defect");
  await pause(1500);
  await smoothScroll(500);
  await pause(1500);
  await h.shot("rtl");
  await clickText("Run checks →");
  await page.waitForSelector("text=Verification Center");
  await pause(800);
  await h.caption("Real tools run: Verilator lint, then a cocotb + Icarus simulation regression.");
  h.waiting(true);
  await clickText("Run all checks");
  await page.waitForSelector("text=Explain this error");
  h.waiting(false);
  await h.caption("Caught. Simulation fails 4 of 7 tests. Later checks don't run, and nothing turns green.");
  await pause(3500);
  await h.shot("verification-fail");
  await clickText("Explain this error");
  await page.waitForSelector("text=Plain-English diagnosis");
  await h.caption("Plain-English diagnosis from the tool evidence. Advisory only: the tools stay authoritative.");
  await pause(4500);
  await h.shot("diagnosis");
  await clickText("Propose a fix");
  await page.waitForSelector("text=Apply fix as new revision");
  await page.locator("text=Bounded repair").scrollIntoViewIfNeeded();
  await h.caption("Bounded repair: a one-line diff as a NEW revision. Tests are never edited, and the failed revision is kept.");
  await pause(4500);
  await h.shot("repair");
  h.waiting(true);
  await clickText("Apply fix as new revision and re-run");
  await h.caption("Re-running everything: lint → simulation → formal proof (SymbiYosys + z3) → synthesis (Yosys).");
  await page.waitForSelector("text=Prototype checks passed: lint");
  h.waiting(false);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await h.caption("All green on revision 2: 7/7 tests, formal PROVED by k-induction, 353 cells, 0 latches.");
  await pause(4500);
  await h.shot("verification-pass");
  const evidence = page.getByRole("button", { name: "Evidence" }).nth(2);
  await evidence.scrollIntoViewIfNeeded();
  await evidence.click();
  await h.caption("Every result is traceable: input hash, tool versions, exact command, exit code, raw log, and properties mapped to requirements.");
  await pause(2000);
  await smoothScroll(900);
  await pause(3000);
  await h.shot("formal-evidence");

  await page.locator(".rail button", { hasText: "Physical design" }).click();
  await page.waitForSelector("text=Physical Design Center");
  await pause(1200);
  await page.fill("input[placeholder='Approver name']", "A. Engineer");
  await clickText("Approve these constraints");
  await page.waitForSelector("text=Approved by A. Engineer");
  await clickText("Run physical design");
  await page.waitForSelector("text=BLOCKED_TOOL_UNAVAILABLE");
  await smoothScroll(700);
  await h.caption("Honesty check: OpenROAD and PDK collateral aren't installed, so layout is reported as BLOCKED, never as a fake GDS.");
  await pause(4500);
  await h.shot("physical-blocked");

  await page.locator(".rail button", { hasText: "Release" }).click();
  await page.waitForSelector("text=Release Center");
  await pause(1200);
  await clickText("Create release candidate");
  await page.waitForSelector("text=Waiting for human review");
  await h.caption("A qualified human signs off. The AI never does.");
  await page.fill("input[placeholder='Reviewer name']", "R. Reviewer");
  await page.fill("input[placeholder^='Role']", "ASIC design engineer");
  await page.locator("text=I am a qualified human reviewer").click();
  const acceptOpen = page.locator("text=I accept these open");
  if (await acceptOpen.count()) await acceptOpen.click();
  await pause(1500);
  await h.shot("signoff");
  await clickText("Sign off release candidate");
  await page.waitForSelector("text=Export release package");
  const [download] = await Promise.all([page.waitForEvent("download"), clickText(/Export release package/)]);
  await page.waitForSelector("text=Integrity verified");
  await page.locator("text=Integrity verified").scrollIntoViewIfNeeded();
  await h.caption("Deterministic ZIP with a SHA-256 manifest, verified on export. Marked 'not submitted' to any foundry.");
  await pause(4500);
  await h.shot("exported");

  await page.locator(".rail button", { hasText: "Reports" }).click();
  await page.waitForSelector("text=plain-English summary");
  await page.getByRole("button", { name: "Engineering report" }).click();
  await page.waitForSelector("text=Requirement-to-verification traceability");
  await page.locator("text=Requirement-to-verification traceability").scrollIntoViewIfNeeded();
  await h.caption("Engineering report: requirement ↔ test ↔ proof traceability, checksums and tool evidence.");
  await pause(4500);
  await h.shot("engineering-report");
  await page.locator(".rail button", { hasText: "Audit trail" }).click();
  await page.waitForSelector("text=AI execution provenance");
  await h.caption("Full audit trail and AI provenance. Swap in any model: local, self-hosted or hosted, under a data-egress policy.");
  await pause(4500);
  await h.shot("audit");
  await h.caption(null);
  return { download: download.suggestedFilename() };
}
