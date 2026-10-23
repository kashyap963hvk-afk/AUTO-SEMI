# Implementation status

_Last updated: 2026-10-23. Spec: `DEVIN_AI_VLSI_CLAUDE_CODE_SPEC.md` v1.1._

## Environment used for verification

Linux container, 4 CPUs, Node 22.22, Python 3.13. Ubuntu 24.04 packages: Verilator 5.020, Icarus Verilog 12.0, Yosys 0.33, z3 4.8.12. SymbiYosys from tag `yosys-0.33`. cocotb 2.1.0. Chromium for browser tests. **Not available:** Docker daemon, OpenROAD/ORFS, any PDK, yices, network access to `api.vercel.com`.

## Phases

| Phase | Status | Exit criterion evidence |
|---|---|---|
| 1 Foundation | Done | Next.js app + typed API, PostgreSQL migrations (PGlite locally / Postgres via `DATABASE_URL`), `.env.example`, docker-compose, tests. Projects persist across restarts (PGlite on disk). |
| 2 Requirements & spec | Done | Mock provider + OpenAI-compatible endpoint (local test server) produce schema-valid requirements. Missing critical info and unaccepted proposals block approval. `local_only` prevents remote calls (tests). |
| 3 Golden path (FIFO) | Done | Reference RTL checked in; template reproduces it byte for byte. Verilator lint, cocotb regression. The planted bug is caught (sim 3/7). CI runs without any LLM. |
| 4 Synthesis & formal | Done | Yosys synthesis with latch check. SymbiYosys: PROVED / COUNTEREXAMPLE_FOUND / BOUNDED_PASS_ONLY distinguished (tests). Repair cap 3. |
| 5 Physical worker | **Blocked (as the spec allows)** | ORFS adapter, preflight, SDC approval bound to its hash, `TIMING_CONSTRAINTS_INCOMPLETE` / `BLOCKED_TOOL_UNAVAILABLE` statuses, all tested. No ORFS/PDK in this environment, so real-flow integration is **not done**. No GDS is ever fabricated. |
| 6 Release | Done | Checklist per policy, stale detection, human sign-off, deterministic ZIP (byte-identical re-export), checksum verification detects tampering (tests). |
| 7 Hardening | Partial | Provider-neutral AI contract + registry + conformance + routing exist (spec v1.1 requires them from Phase 1). Not started: OpenLane 2, more PDKs, DFT/ATPG, UVM simulator adapter, multi-block designs, OIDC, durable job queue, rate limiting. |

## Commands run and results

| Command | Result |
|---|---|
| `cd worker && python -m pytest -q` | **37 passed** (unit, API, and real-tool integration: lint, 7-test sim, k-induction proof, BMC = bounded, planted bug → sim FAIL + formal counterexample with VCD, synthesis, physical blocked, PDR and unrolled-z3 proofs of the hard 32-bit async case) |
| `cd apps/web && npm test` | **35 passed** (domain, AI layer, golden path with recorded real evidence, WASM Yosys) |
| `npm run typecheck`, `npm run lint`, `npm run build` | clean |
| `npx tsx scripts/sync-design-assets.ts --check` | up to date |
| `npx tsx scripts/record-demo.ts` | 2-minute 1080p demo video recorded from the live app (`docs/linkedin/`) |
| `npx tsx scripts/e2e-golden-path.ts` (Chromium) | PASS against the live worker **and** in Vercel mode (no worker, `/tmp` DB) |
| `npm run evidence:record -- --grid full --prune` | 292 jobs over 73 configurations: 290 PASS, 2 expected FAIL (planted bug: sim 3/7 and formal counterexample) |
| `npx tsx scripts/tough-cases.ts` (live worker) | **30/30** tough cases behaved as required: 10 hard plain-English requirements taken through the full flow with real tools, plus 20 abuse/edge cases. See [docs/tough-cases-report.md](docs/tough-cases-report.md) |

## Problems found while building, and fixes

- Verilator `-Wall` flagged a real `WIDTHTRUNC` in the first RTL draft. Fixed in the RTL, not waived.
- Boolector crashes with a broken pipe on this system. z3 is the default, and preflight documents this.
- cocotb 2.x needs Verilator ≥ 5.036 (installed: 5.020), so simulation uses Icarus. Reported by preflight.
- Formal at DEPTH 64: the vacuity cover for `full` needed 64+ BMC steps (10 min). Covers now target 16 items for DEPTH > 16; full-flag reachability is shown by simulation, and this is disclosed in every formal result.
- 32-bit async-reset FIFOs: plain z3 k-induction timed out and the cover hit z3 out-of-memory. Fixed by `smtbmc --unroll z3` (8 s), with an ABC PDR fallback. Both are covered by tests.
- Several harness bugs found by the tough-case suite (NDJSON parsing) were fixed in the harness. No product change was needed.

## Not implemented / known gaps

- Real OpenROAD Flow Scripts run, STA, DRC/LVS/antenna, GDS (blocked: tools/PDK absent).
- Coverage collection, UVM, DFT/ATPG, power analysis.
- Native Anthropic adapter is implemented but was not exercised against the live API (no key in this environment).
- Durable job queue (checks run in-request, up to 300 s), OIDC, rate limiting.
- Docker images were written but not built here (no Docker daemon).
- Vercel deployment: the network policy of this environment refuses `api.vercel.com`, so deployment must be triggered from the Vercel dashboard (README → "Deploy with Vercel").

## Next exact task

Provision an ORFS + SKY130 worker image, then run the physical adapter end to end on the default FIFO and replace the fixture-only parsing with parsers for the real ORFS reports.
