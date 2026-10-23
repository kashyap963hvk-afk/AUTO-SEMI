/**
 * Records the product demo video (for sharing, e.g. LinkedIn) by driving one tough project
 * through the real UI, RTL to GDSII. Frames come from the Chrome DevTools screencast (crisp
 * text), captions are burned in for muted autoplay, and waits on real tools are
 * fast-forwarded with an on-screen badge naming the factor. The closing card is built from
 * the run's own check results, so it cannot claim more than the tools reported. Requires
 * ffmpeg and a worker with ORFS + SKY130 (see worker/scripts/install-orfs.sh).
 *   BASE_URL=http://127.0.0.1:3000 npx tsx scripts/record-demo.ts --out ../../docs/linkedin/auto-vlsi-demo.mp4
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { toughProject } from "./lib/toughProject";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const outIdx = process.argv.indexOf("--out");
const OUT = path.resolve(outIdx > 0 ? process.argv[outIdx + 1] : "demo.mp4");
const FRAMES = path.resolve(process.env.DEMO_FRAMES_DIR ?? "/tmp/auto-vlsi-demo-frames");
const CHROMIUM = process.env.CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);

const OVERLAY = `
(() => {
  const install = () => {
    if (document.getElementById("__demo_caption")) return;
    const style = document.createElement("style");
    style.textContent = \`
      #__demo_caption { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%) translateY(12px); z-index: 99999;
        max-width: 1180px; padding: 16px 26px; border-radius: 16px; font: 600 21px/1.4 Inter, system-ui, sans-serif; color: #f1f5f9;
        background: rgba(8, 12, 20, 0.88); border: 1px solid rgba(94, 234, 212, 0.45); box-shadow: 0 18px 50px rgba(0,0,0,.55);
        backdrop-filter: blur(8px); opacity: 0; transition: opacity .35s ease, transform .35s ease; text-align: center; pointer-events: none; }
      #__demo_caption.on { opacity: 1; transform: translateX(-50%) translateY(0); }
      #__demo_ff { position: fixed; top: 13px; left: 50%; transform: translateX(-50%); z-index: 99999; padding: 8px 14px; border-radius: 999px; pointer-events: none;
        font: 700 15px Inter, system-ui, sans-serif; color: #0b0f17; background: #c084fc; display: none; }
      #__demo_cursor { position: fixed; z-index: 100000; width: 22px; height: 22px; margin: -4px 0 0 -4px; pointer-events: none;
        transition: left .45s cubic-bezier(.2,.8,.2,1), top .45s cubic-bezier(.2,.8,.2,1); left: 50%; top: 50%; }
      #__demo_cursor svg { filter: drop-shadow(0 2px 4px rgba(0,0,0,.6)); }
      .__demo_ripple { position: fixed; z-index: 99998; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%;
        border: 3px solid #5eead4; pointer-events: none; animation: __rip .55s ease-out forwards; }
      @keyframes __rip { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
      .toast { display: none !important; }\`;
    document.head.appendChild(style);
    const cap = document.createElement("div"); cap.id = "__demo_caption"; document.body.appendChild(cap);
    const ff = document.createElement("div"); ff.id = "__demo_ff"; document.body.appendChild(ff);
    const cur = document.createElement("div"); cur.id = "__demo_cursor";
    cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#fff" stroke="#0b0f17" stroke-width="1.5"/></svg>';
    document.body.appendChild(cur);
    const saved = sessionStorage.getItem("__demo_cursor");
    if (saved) { const [x, y] = JSON.parse(saved); cur.style.transition = "none"; cur.style.left = x + "px"; cur.style.top = y + "px"; requestAnimationFrame(() => (cur.style.transition = "")); }
    document.addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; sessionStorage.setItem("__demo_cursor", JSON.stringify([e.clientX, e.clientY])); }, true);
    document.addEventListener("mousedown", (e) => { const r = document.createElement("div"); r.className = "__demo_ripple"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px"; document.body.appendChild(r); setTimeout(() => r.remove(), 700); }, true);
    const last = sessionStorage.getItem("__demo_caption_text");
    if (last) { cap.textContent = last; cap.classList.add("on"); }
  };
  window.__demoCaption = (t) => { install(); const c = document.getElementById("__demo_caption"); if (!t) { c.classList.remove("on"); sessionStorage.removeItem("__demo_caption_text"); return; }
    c.classList.remove("on"); setTimeout(() => { c.textContent = t; c.classList.add("on"); }, 180); sessionStorage.setItem("__demo_caption_text", t); };
  window.__demoFF = (on, factor) => { install(); const f = document.getElementById("__demo_ff"); f.textContent = "⏩ " + factor + "× faster · real EDA tools running"; f.style.display = on ? "block" : "none"; };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install); else install();
})();
`;

function card(title: string, subtitle: string, done: string[], notDone: string[], foot: string) {
  const li = (cls: string, l: string) => `<li class="${cls}">${l}</li>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;800&display=swap" rel="stylesheet"><style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(900px 500px at 15% 0%,rgba(94,234,212,.16),transparent 60%),radial-gradient(800px 500px at 100% 100%,rgba(129,140,248,.18),transparent 60%),#0b0f17;color:#e6ecf5;font-family:Inter,system-ui,sans-serif}
  .w{max-width:1400px;padding:0 60px}.b{display:inline-block;padding:0 16px;height:58px;border-radius:14px;background:conic-gradient(from 210deg,#5eead4,#818cf8,#5eead4);color:#0b0f17;font-weight:800;font-size:24px;line-height:58px;text-align:center;box-shadow:0 0 40px rgba(94,234,212,.4)}
  h1{font-size:60px;letter-spacing:-.03em;margin:22px 0 10px;line-height:1.05}h1 span{background:linear-gradient(90deg,#5eead4,#818cf8);-webkit-background-clip:text;color:transparent}
  p{font-size:26px;color:#93a1b8;margin:0 0 22px}ul{padding:0;margin:0 0 6px}li{font-size:22px;margin:8px 0;color:#cbd5e1;list-style:none}
  li.y:before{content:"✓  ";color:#4ade80;font-weight:800}li.n{color:#fca5a5}li.n:before{content:"✗  ";color:#f87171;font-weight:800}
  h2{font-size:18px;letter-spacing:.12em;text-transform:uppercase;color:#66748c;margin:22px 0 6px}
  .f{margin-top:28px;font-size:19px;color:#66748c}</style></head><body><div class="w"><div class="b">Auto-VLSI</div><h1>${title}</h1><p>${subtitle}</p>
  ${done.length ? `<h2>${notDone.length ? "Done, with tool evidence" : ""}</h2><ul>${done.map((l) => li("y", l)).join("")}</ul>` : ""}
  ${notDone.length ? `<h2>Not done</h2><ul>${notDone.map((l) => li("n", l)).join("")}</ul>` : ""}
  <div class="f">${foot}</div></div></body></html>`)}`;
}

(async () => {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);

  const frames: { file: string; t: number }[] = [];
  const fast: { from: number; to: number; factor: number }[] = [];
  let fastFrom: { t: number; factor: number } | null = null;
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", async (f) => {
    const file = path.join(FRAMES, `f${String(frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const now = () => Date.now() / 1000;
  const hold = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ff = (on: boolean, factor: number) => {
    page.evaluate(([x, k]) => (window as unknown as { __demoFF: (on: boolean, k: number) => void }).__demoFF(x as boolean, k as number), [on, factor]).catch(() => {});
    if (on) fastFrom = { t: now(), factor };
    else if (fastFrom !== null) {
      fast.push({ from: fastFrom.t, to: now(), factor: fastFrom.factor });
      fastFrom = null;
    }
  };

  await page.goto(card("One tough project: <span>English → GDSII</span>", "32 × 32-bit DMA FIFO · async reset · 200 MHz · SkyWater SKY130 · recorded live", [], [], "Real open-source tools: Verilator · cocotb + Icarus · SymbiYosys + z3 · Yosys · OpenROAD · KLayout"));
  await hold(4500);

  const res = await toughProject(page, BASE, {
    slow: true,
    shot: async () => {},
    caption: async (t) => {
      await page.evaluate((x) => (window as unknown as { __demoCaption: (t: string | null) => void }).__demoCaption(x), t).catch(() => {});
    },
    waiting: (on) => ff(on, 6),
    waitingFast: ff,
  });
  await hold(1500);

  // Closing card: built only from what the physical run itself reported.
  if (res.physicalMode !== "live-worker" && process.env.ALLOW_RECORDED_PHYSICAL !== "1") {
    throw new Error(`physical design was served as "${res.physicalMode}", not run live; refusing to publish a video that implies a live run`);
  }
  const pm = res.physical;
  const c = pm.checks;
  const pass = (k: string) => c[k] === "PASS";
  const done = [
    "Spec from plain English; every requirement approved by a human",
    `Planted bug caught by simulation (${res.simCaught} failed) → fixed in a new revision → ${res.simFinal} pass`,
    "Formal proof (k-induction) of the FIFO safety properties at RTL",
    `GDSII produced: ${Math.round(pm.design_area_um2 as number).toLocaleString()} µm² of cells, ${pm.utilization_pct}% utilization`,
    pass("sta_setup") && pass("sta_hold") ? `Setup + hold timing met at 200 MHz: +${pm.worst_slack_ns} ns slack (typical corner only)` : `Timing NOT met: setup ${c.sta_setup}, hold ${c.sta_hold}`,
    `LVS ${pm.lvs === "MATCH" ? "match" : String(pm.lvs)} · router DRC ${pm.route_drc_violations} · antenna ${pm.antenna_net_violations} · KLayout DRC ${pm.klayout_drc_violations} (${c.klayout_drc_feol === "PASS" ? "front-end + metal rules, open deck" : "metal layers only"})`,
  ];
  const notDone = [
    c.klayout_drc_feol === "PASS" ? "" : `Front-end (FEOL) DRC: ${c.klayout_drc_feol ?? "NOT_RUN"}`,
    c.multi_corner_sta === "PASS" ? "" : `Slow/fast-corner timing. +${pm.worst_slack_ns} ns at typical could fail at the slow corner`,
    c.equivalence_check === "PASS" ? "" : "Equivalence check of the final netlist vs RTL",
    "No I/O pads, seal ring, density fill check or foundry sign-off deck. A prototype layout, not a tape-out",
  ].filter(Boolean);
  await page.goto(card("What is real, <span>what is not</span>", `A ${Math.round((pm.clock_period_ns as number) ? 1000 / (pm.clock_period_ns as number) : 0)} MHz block, RTL to GDSII, in about ${Math.max(1, Math.round(res.physicalSeconds / 60))} minutes of layout compute`, done, notDone, "Auto-VLSI · open source · provider-neutral AI · github.com/kashyap963hvk-afk/auto-vlsi"));
  await hold(11000);
  await cdp.send("Page.stopScreencast");
  await browser.close();

  // Assemble: each frame lasts until the next one; tool waits are sped up by their factor.
  // Frames shorter than one output frame are dropped (their time carries to the next kept
  // frame) rather than stretched, so a 30x segment really plays 30x faster.
  const factorAt = (t: number) => fast.find((w) => t >= w.from - 0.2 && t <= w.to)?.factor ?? 1;
  const lines: string[] = [];
  let total = 0;
  let carry = 0;
  for (let i = 0; i < frames.length; i++) {
    const last = i + 1 === frames.length;
    carry += Math.min((last ? 1.5 : frames[i + 1].t - frames[i].t) / factorAt(frames[i].t), 6);
    if (carry < 1 / 30 && !last) continue;
    total += carry;
    lines.push(`file '${frames[i].file}'`, `duration ${carry.toFixed(4)}`);
    carry = 0;
  }
  lines.push(`file '${frames.at(-1)!.file}'`);
  const list = path.join(FRAMES, "list.txt");
  writeFileSync(list, lines.join("\n") + "\n");
  mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0f17,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", OUT], { stdio: "inherit" });
  console.log(`wrote ${OUT}: ${frames.length} frames, ~${total.toFixed(0)} s, ${fast.length} sped-up tool waits`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
