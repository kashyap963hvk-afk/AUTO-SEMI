# Implementation status

_Last updated: 2026-10-23. Spec: `DEVIN_AI_VLSI_CLAUDE_CODE_SPEC.md` v1.1._

## Environment used for verification

Linux container, 4 CPUs, Node 22.22, Python 3.13. Ubuntu 24.04 packages: Verilator 5.020, Icarus Verilog 12.0, Yosys 0.33, z3 4.8.12. SymbiYosys from tag `yosys-0.33`. cocotb 2.1.0. Chromium for browser tests. Physical: OpenROAD Flow Scripts `d5cc6022`, OpenROAD 2.0-12381-g01bba3695 and Yosys 0.38 (litex-hub conda), KLayout 0.28.16, SKY130 `sky130hd` platform (installed with `worker/scripts/install-orfs.sh`). **Not available:** Docker daemon, eqy, ss/ff corner libraries, yices, network access to `api.vercel.com`.

## Phases

| Phase | Status | Exit criterion evidence |
|---|---|---|
| 1 Foundation | Done | Next.js app + typed API, PostgreSQL migrations (PGlite locally / Postgres via `DATABASE_URL`), `.env.example`, docker-compose, tests. Projects persist across restarts (PGlite on disk). |
| 2 Requirements & spec | Done | Mock provider + OpenAI-compatible endpoint (local test server) produce schema-valid requirements. Missing critical info and unaccepted proposals block approval. `local_only` prevents remote calls (tests). |
| 3 Golden path (FIFO) | Done | Reference RTL checked in; template reproduces it byte for byte. Verilator lint, cocotb regression. The planted bug is caught (sim 3/7). CI runs without any LLM. |
| 4 Synthesis & formal | Done | Yosys synthesis with latch check. SymbiYosys: PROVED / COUNTEREXAMPLE_FOUND / BOUNDED_PASS_ONLY distinguished (tests). Repair cap 3. |
| 5 Physical worker | **Done for one PDK, one corner** | Real ORFS RTL→GDSII on sky130hd, post-route antenna, KLayout FEOL+BEOL DRC, KLayout LVS. 32×32 FIFO @ 200 MHz: every required check PASS, worst slack +0.08 ns (tt only). 8×16 @ 50 MHz: every required check PASS after fixing a real DRC failure (m3.2) in the flow's floorplan. NOT RUN, and shown so: ss/ff corners, netlist-vs-RTL equivalence. Details: [docs/physical-design-report.md](docs/physical-design-report.md). |
| 6 Release | Done | Checklist per policy, stale detection, human sign-off, deterministic ZIP (byte-identical re-export), checksum verification detects tampering (tests). |
| 7 Hardening | Partial | Provider-neutral AI contract + registry + conformance + routing exist (spec v1.1 requires them from Phase 1). Not started: OpenLane 2, more PDKs, DFT/ATPG, UVM simulator adapter, multi-block designs, OIDC, durable job queue, rate limiting. |

## Commands run and results

| Command | Result |
|---|---|
| `cd worker && python -m pytest -q` | **46 passed** + 1 real RTL→GDS test (PASS with ORFS present) (unit, API, and real-tool integration: lint, 7-test sim, k-induction proof, BMC = bounded, planted bug → sim FAIL + formal counterexample with VCD, synthesis, physical blocked without SDC/tools, ORFS report parsing from a real run, LVS/DRC deck patches refuse to guess, PDR and unrolled-z3 proofs of the hard 32-bit async case) |
| `cd apps/web && npm test` | **37 passed** (domain, AI layer, golden path with recorded real evidence, WASM Yosys) |
| `npm run typecheck`, `npm run lint`, `npm run build` | clean |
| `npx tsx scripts/sync-design-assets.ts --check` | up to date |
| `npx tsx scripts/record-demo.ts` | 1080p video of one tough project (32×32 FIFO, 200 MHz, SKY130) from plain English to GDSII and a verified release package, recorded from the live app with a live physical run (`docs/linkedin/auto-vlsi-demo.mp4`) |
| `npx tsx scripts/e2e-golden-path.ts` (Chromium) | PASS against the live worker **and** in Vercel mode (no worker, `/tmp` DB) |
| `npm run evidence:record -- --grid full --physical --prune` | 294 jobs: 292 RTL jobs over 73 configurations (290 PASS, 2 expected FAIL from the planted bug: sim 3/7 and a formal counterexample) and 2 physical jobs (200 MHz 32×32: PASS, slack +0.08 ns; 50 MHz 8×16: PASS) |
| `pytest -k rtl_to_gds` with ORFS | PASS: a real sky130hd run asserting flow, STA, FEOL+BEOL DRC and LVS (it failed on DRC m3.2 before the core-margin fix) |
| FEOL DRC negative control (`worker/scripts/drc-negative-control.py`) | 3 planted FEOL violations → `difftap.1`, `poly.1a`, `nwell.1`/`nwell.2a` all flagged by the same deck and mode |
| `npx tsx scripts/tough-cases.ts` (live worker) | **30/30** tough cases behaved as required: 10 hard plain-English requirements taken through the full flow with real tools, plus 20 abuse/edge cases. See [docs/tough-cases-report.md](docs/tough-cases-report.md) |

## Problems found while building, and fixes

- Verilator `-Wall` flagged a real `WIDTHTRUNC` in the first RTL draft. Fixed in the RTL, not waived.
- Boolector crashes with a broken pipe on this system. z3 is the default, and preflight documents this.
- cocotb 2.x needs Verilator ≥ 5.036 (installed: 5.020), so simulation uses Icarus. Reported by preflight.
- Formal at DEPTH 64: the vacuity cover for `full` needed 64+ BMC steps (10 min). Covers now target 16 items for DEPTH > 16; full-flag reachability is shown by simulation, and this is disclosed in every formal result.
- 32-bit async-reset FIFOs: plain z3 k-induction timed out and the cover hit z3 out-of-memory. Fixed by `smtbmc --unroll z3` (8 s), with an ABC PDR fallback. Both are covered by tests.
- Several harness bugs found by the tough-case suite (NDJSON parsing) were fixed in the harness. No product change was needed.
- ORFS on sky130hd failures fixed along the way:
  - the variable name is `YOSYS_CMD`, not `YOSYS_EXE`;
  - `rcx_patterns.rules` is a symlink into sky130hs;
  - ORFS checks antennas only after global routing, so a post-route `check_antennas` step was added.
- Shipped LVS deck:
  - it called `report()` and wrote no LVS database;
  - the substrate layer 236/0 is absent, which split VSS/VNB;
  - fill/tap cells have no devices;
  - the platform CDL has malformed cells the design does not use.
  These are fixed with three exact deck patches and a pruned CDL. The adapter refuses to run if a patch does not apply.
- FEOL DRC did not finish in KLayout's deep mode (licon.12/13 ran for more than 35 minutes). Tiled flat mode runs the whole deck in about 2 minutes. This was validated with a negative control.
- **Small dies failed KLayout DRC (4× `m3.2`).**
  - Cause: ORFS's 1 µm die-to-core margin is shorter than the 0.8 µm met3 IO pins plus spacing, so a pin landed 25 nm from a core-edge PDN via.
  - Deep mode gave the same markers, so it is not a tiling artefact.
  - Fix: `CORE_MARGIN = 4 µm` (job option `core_margin_um`, part of the hashed inputs).
  - Side effect, reported: the 200 MHz slack went from +0.17 to +0.08 ns.
- The FEOL DRC verdict counts only rules from the deck's FEOL block. A metal-3 spacing failure is reported as a DRC failure, not as an FEOL failure.
- **Live physical runs over HTTP silently fell back to recorded evidence.**
  - Cause: Node's `fetch` (undici) has a fixed 300 s headers timeout that an `AbortSignal` cannot extend, and a layout run takes about 6 minutes.
  - How it was found: in the first video take, the result was labelled "Recorded real run".
  - Fix: the worker call now uses `node:http` with one overall deadline.
  - The runner now adds a `WORKER_FAILED_RECORDED_USED` warning whenever it falls back, and the video recorder refuses to publish unless the physical stage was live.
- **A failed layout left the project at a dead end.**
  - Found with the browser E2E once ORFS was present: `FAILED` had no transition to release review.
  - So one failing DRC made even an RTL-only package impossible, although every RTL check passed on the same revision.
  - `FAILED` may now go to release review or a physical re-run. The policy checklist is the gate: the RTL-only package discloses the failed layout, and the physical policy is blocked. Both are covered by tests.

## Not implemented / known gaps

- Physical design is limited to:
  - one PDK (sky130hd) and one timing corner (tt);
  - the open ORFS DRC/LVS decks, not foundry sign-off;
  - no equivalence check, no pad ring, seal ring or density check.
- The 200 MHz layout meets timing by only +0.08 ns at tt. The ss corner is not checked; with 80 ps of margin, a pass there should not be expected.
- Live physical design needs a worker. On Vercel only the two recorded configurations return physical results.
- Coverage collection, UVM, DFT/ATPG, power analysis.
- Native Anthropic adapter is implemented but was not exercised against the live API (no key in this environment).
- Durable job queue (checks run in-request, up to 300 s), OIDC, rate limiting.
- Docker images were written but not built here (no Docker daemon).
- Vercel deployment: the network policy of this environment refuses `api.vercel.com`, so deployment must be triggered from the Vercel dashboard (README → "Deploy with Vercel").

## Next exact task

Add ss/ff corner STA (install the sky130 ss/ff Liberty files and run OpenSTA per corner), add an eqy equivalence check of the routed netlist against the RTL. If ss fails at 200 MHz, report it as a FAIL and offer the next safe clock instead of hiding it.
