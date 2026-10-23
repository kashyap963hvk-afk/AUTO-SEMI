# LinkedIn kit

**Video:** `docs/linkedin/devin-ai-vlsi-demo.mp4` (1920×1080, H.264, muted autoplay-friendly captions burned in).
**Thumbnail/cover:** `docs/linkedin/cover.png`.

Upload the MP4 as a native LinkedIn video (not a link) and paste the post below. Replace the bracketed links once the Vercel URL is live.

---

## Post (≈1,250 characters)

What if you could describe a chip in plain English and get verified hardware back, with proof you can audit?

I built **Devin AI for VLSI**, an AI-guided flow for small digital ASIC blocks. In the video:

🗣️ I type: "a buffer that holds 16 bytes for a UART receiver, 50 MHz, SKY130"
🧭 It asks short, plain-English questions. Every AI suggestion stays labelled as a proposal until a human approves it.
📐 It writes a versioned spec and architecture, then generates RTL.
🐞 I plant a real bug. Simulation catches it (4 of 7 tests fail) and nothing turns green.
🔧 It proposes a one-line fix as a new revision, without touching the tests. Re-run: 7/7 tests pass, the formal proof completes (k-induction), synthesis comes back with 0 latches.
🚫 Layout tools aren't installed, so physical design shows BLOCKED instead of a fake GDS.
📦 A human signs off and it exports a SHA-256-verified package, marked "not submitted to any foundry".

The part I care most about: **AI proposes, real tools decide.** Pass/fail only ever comes from Verilator, cocotb + Icarus, SymbiYosys/z3 and Yosys. Never from model prose.

It's also model-agnostic: plug in a local model, a self-hosted gateway or a hosted API under a data-egress policy (local-only by default).

I also stress-tested it with 30 tough cases: contradictory specs, 5 nm and dual-clock asks, prompt injection, tampered packages, SSRF attempts. All handled.

🔗 Live demo: [Vercel URL]
💻 Code: github.com/kashyap963hvk-afk/AUTO-SEMI

#VLSI #ASIC #SemiconductorDesign #EDA #RTL #Verification #FormalVerification #OpenSource #AI #HardwareDesign

---

## Shorter variant (≈500 characters)

Plain English in, verified chip RTL out, with evidence you can audit.

Devin AI for VLSI turns "a 16-byte UART buffer at 50 MHz on SKY130" into an approved spec, RTL, a 7-test cocotb regression, a SymbiYosys proof and Yosys synthesis. In the demo I plant a bug, it gets caught, and a bounded fix lands as a new revision.

AI proposes; real tools decide. Layout is reported BLOCKED, never faked.

🔗 [Vercel URL] · 💻 github.com/kashyap963hvk-afk/AUTO-SEMI
#VLSI #EDA #AI #ASIC

---

## Honesty notes (keep the claims accurate)

- Scope: one design family (synchronous FIFO), prototype flow, public-PDK targets. It is not "any chip" and not foundry sign-off.
- The video runs locally with a live EDA worker. The Vercel deployment reuses recorded real-tool results (matched by exact input hash) plus in-process Yosys, and labels them that way.
- The default AI in the demo is the built-in deterministic engine, labelled "mock" in the UI. Connecting an LLM is optional.
