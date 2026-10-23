/**
 * Records the product demo video (for sharing, e.g. LinkedIn) by driving the real golden
 * path. Frames come from the Chrome DevTools screencast (crisp text), captions are burned
 * in for muted autoplay, and waits on real tools are fast-forwarded with an on-screen
 * "sped up" badge. Requires ffmpeg.
 *   BASE_URL=http://127.0.0.1:3000 npx tsx scripts/record-demo.ts --out ../../docs/linkedin/devin-ai-vlsi-demo.mp4
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { goldenPath } from "./lib/goldenPath";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const outIdx = process.argv.indexOf("--out");
const OUT = path.resolve(outIdx > 0 ? process.argv[outIdx + 1] : "demo.mp4");
const FRAMES = path.resolve(process.env.DEMO_FRAMES_DIR ?? "/tmp/devin-demo-frames");
const SPEEDUP = 6;
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
      #__demo_ff { position: fixed; top: 76px; right: 26px; z-index: 99999; padding: 8px 14px; border-radius: 999px; pointer-events: none;
        font: 700 15px Inter, system-ui, sans-serif; color: #0b0f17; background: #c084fc; display: none; }
      #__demo_cursor { position: fixed; z-index: 100000; width: 22px; height: 22px; margin: -4px 0 0 -4px; pointer-events: none;
        transition: left .45s cubic-bezier(.2,.8,.2,1), top .45s cubic-bezier(.2,.8,.2,1); left: 50%; top: 50%; }
      #__demo_cursor svg { filter: drop-shadow(0 2px 4px rgba(0,0,0,.6)); }
      .__demo_ripple { position: fixed; z-index: 99998; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%;
        border: 3px solid #5eead4; pointer-events: none; animation: __rip .55s ease-out forwards; }
      @keyframes __rip { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }\`;
    document.head.appendChild(style);
    const cap = document.createElement("div"); cap.id = "__demo_caption"; document.body.appendChild(cap);
    const ff = document.createElement("div"); ff.id = "__demo_ff"; ff.textContent = "⏩ ${SPEEDUP}× · real EDA tools running"; document.body.appendChild(ff);
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
  window.__demoFF = (on) => { install(); document.getElementById("__demo_ff").style.display = on ? "block" : "none"; };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install); else install();
})();
`;

function card(title: string, subtitle: string, lines: string[], foot: string) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;800&display=swap" rel="stylesheet"><style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(900px 500px at 15% 0%,rgba(94,234,212,.16),transparent 60%),radial-gradient(800px 500px at 100% 100%,rgba(129,140,248,.18),transparent 60%),#0b0f17;color:#e6ecf5;font-family:Inter,system-ui,sans-serif}
  .w{max-width:1250px;padding:0 60px}.b{display:inline-block;width:58px;height:58px;border-radius:14px;background:conic-gradient(from 210deg,#5eead4,#818cf8,#5eead4);color:#0b0f17;font-weight:800;font-size:24px;line-height:58px;text-align:center;box-shadow:0 0 40px rgba(94,234,212,.4)}
  h1{font-size:68px;letter-spacing:-.03em;margin:26px 0 10px;line-height:1.05}h1 span{background:linear-gradient(90deg,#5eead4,#818cf8);-webkit-background-clip:text;color:transparent}
  p{font-size:28px;color:#93a1b8;margin:0 0 28px}li{font-size:24px;margin:10px 0;color:#cbd5e1;list-style:none}li:before{content:"✓  ";color:#4ade80;font-weight:800}
  .f{margin-top:34px;font-size:19px;color:#66748c}</style></head><body><div class="w"><div class="b">AI</div><h1>${title}</h1><p>${subtitle}</p><ul style="padding:0">${lines.map((l) => `<li>${l}</li>`).join("")}</ul><div class="f">${foot}</div></div></body></html>`)}`;
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
  const fast: { from: number; to: number }[] = [];
  let fastFrom: number | null = null;
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

  await page.goto(card("Plain English <span>→ verified chip RTL</span>", "Devin AI for VLSI: an auditable AI design flow for digital ASIC blocks", ["Guided requirements a non-engineer can answer", "Real tools: Verilator · cocotb · SymbiYosys · Yosys", "Honest evidence: nothing passes unless a tool says so"], "Recorded live from the running app · open-source toolchain"));
  await hold(4500);

  await goldenPath(page, BASE, {
    slow: true,
    shot: async () => {},
    caption: async (t) => {
      await page.evaluate((x) => (window as unknown as { __demoCaption: (t: string | null) => void }).__demoCaption(x), t).catch(() => {});
    },
    waiting: (on) => {
      page.evaluate((x) => (window as unknown as { __demoFF: (on: boolean) => void }).__demoFF(x), on).catch(() => {});
      if (on) fastFrom = now();
      else if (fastFrom !== null) {
        fast.push({ from: fastFrom, to: now() });
        fastFrom = null;
      }
    },
  });
  await hold(1500);
  await page.goto(card("From a sentence <span>to a reviewed package</span>", "One golden path, end to end, in a few minutes", ["Spec approved by a human. AI guesses are always labelled", "Planted bug caught by simulation, fixed in a new revision", "Formal proof (k-induction), synthesis, SHA-256 release ZIP", "Layout honestly BLOCKED until OpenROAD + PDK exist"], "Provider-neutral AI · local or hosted models · deploys on Vercel"));
  await hold(5000);
  await cdp.send("Page.stopScreencast");
  await browser.close();

  // Assemble: each frame lasts until the next one; tool waits are sped up.
  const inFast = (t: number) => fast.some((w) => t >= w.from - 0.2 && t <= w.to);
  const lines: string[] = [];
  let total = 0;
  for (let i = 0; i < frames.length; i++) {
    let d = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 1.5;
    if (inFast(frames[i].t)) d /= SPEEDUP;
    d = Math.min(Math.max(d, 1 / 60), 6);
    total += d;
    lines.push(`file '${frames[i].file}'`, `duration ${d.toFixed(4)}`);
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
