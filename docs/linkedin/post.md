# LinkedIn kit

**Video:** `docs/linkedin/auto-vlsi-demo.mp4` (1920×1080, H.264, captions burned in for muted autoplay).
**Thumbnail/cover:** `docs/linkedin/cover.png`.

Upload the MP4 as a native LinkedIn video, not a link, and paste the post below. Replace `[Vercel URL]` once the deployment is live.

---

## Post (≈1,500 characters)

I gave an AI-guided chip flow one tough job and recorded it end to end, from plain English to GDSII.

The ask: "a FIFO that stores 32 values of 32 bits between a DMA engine and a CPU, async active-low reset, 200 MHz, SKY130."

What happened in **Auto-VLSI**:
🧭 It asked about a corner case I never mentioned instead of guessing. Each value stayed a proposal until I approved it.
🐞 I planted a real bug. Simulation caught it (4 of 7 tests failed) and nothing turned green.
🔧 A one-line fix landed as a new revision with the tests untouched: 7/7 pass, a k-induction proof completed, Yosys synthesis reported 0 latches.
🧱 OpenROAD laid it out on SKY130:
- 49,822 µm² of cells
- LVS match
- 0 DRC markers (front-end and metal rules), 0 antenna violations
- timing met at 200 MHz

The brutally honest part:
⚠️ Slack is only +0.08 ns (80 ps), and only at the typical corner. Slow/fast corners were NOT run. That's unmeasured, but with 80 ps of margin I wouldn't expect it to pass the slow corner.
⚠️ No equivalence check between the routed netlist and the RTL.
⚠️ These are the open-source decks, not foundry sign-off. There are no pads, seal ring or density checks. It's a prototype block, not a tape-out.
❌ My own flow failed DRC on small designs at first: an IO pin sat 25 nm from a power-grid via. The tool reported FAIL and blocked the release until I fixed the floorplan margin. The fix cost the 200 MHz design half of its slack.

AI proposes; real tools decide. Every PASS comes from Verilator, cocotb, SymbiYosys, Yosys, OpenROAD or KLayout, never from model prose. Every gap shows up as NOT RUN, and a human must accept it by name.

🔗 [Vercel URL]
💻 github.com/kashyap963hvk-afk/auto-vlsi

#VLSI #ASIC #PhysicalDesign #OpenROAD #SKY130 #EDA #Verification #OpenSource #AI

---

## Shorter variant (≈550 characters)

Plain English → verified RTL → GDSII on SKY130, recorded live.

For a 32×32 FIFO at 200 MHz, Auto-VLSI ran the full chain: a planted bug caught, then fixed, 7/7 tests, a formal proof, OpenROAD layout, LVS match and 0 DRC.

Not done, and shown as NOT RUN: slow/fast corners (slack is +0.08 ns at typical only) and the netlist-vs-RTL equivalence check. Open decks, not sign-off.

🔗 [Vercel URL] · 💻 github.com/kashyap963hvk-afk/auto-vlsi
#VLSI #EDA #OpenROAD #AI

---

## Honesty notes (keep the claims accurate)

- **Scope.** One design family (synchronous FIFOs), one PDK (sky130hd) and one timing corner (tt). It is not "any chip" and not foundry sign-off. Full numbers and gaps: `docs/physical-design-report.md`.
- **The video's physical run was live** on a local worker (OpenROAD + KLayout). The recorder refuses to publish if the physical stage was served from recorded evidence. The 30× badge marks the sped-up wait, and the real duration is shown on screen.
- **On Vercel there is no layout tool.** Physical results exist only for the two recorded configurations, labelled "Recorded real run". Every other configuration shows BLOCKED.
- **The default AI** in the demo is the built-in deterministic engine, labelled "mock" in the UI. Connecting an LLM is optional.
