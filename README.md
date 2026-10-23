# Auto-VLSI

**Describe the chip you need in plain English. Get a reviewed specification, verified RTL, real tool evidence, and a hashed release package for a qualified engineer to review.**

This repository implements the first release of the product specified in (codename "Devin AI for VLSI" in the spec) [`DEVIN_AI_VLSI_CLAUDE_CODE_SPEC.md`](DEVIN_AI_VLSI_CLAUDE_CODE_SPEC.md) (v1.1). It covers one design family (synchronous FIFOs) end to end, plain English to GDSII on SKY130, with an auditable workflow, real open-source EDA tools and provider-neutral AI.

> This is a prototype/educational flow. It does not design arbitrary chips, it is not foundry sign-off, and it never submits anything to a foundry. Every check shows whether it ran, how, and with which tool version.

## What it does

| Step | What happens | Evidence |
|---|---|---|
| 1. Describe | Plain-English intake. The requirements analyst extracts only values you actually stated (each must quote your words) and flags out-of-scope asks. | AI execution record (provider, model, prompt version, hashes) |
| 2. Discover | One question at a time, with "I know", "Suggest one" and "Not sure" answers. Suggestions stay labelled as AI proposals. | Per-field source / status / rationale |
| 3. Approve spec | Versioned `design_spec.yaml`. Critical unknowns block approval. Every AI proposal needs explicit acceptance. | Immutable spec revisions + audit event |
| 4. Architecture | Block diagram, interface contract, decisions with alternatives, risks. | Approved architecture revision |
| 5. RTL | Deterministic template, immutable SHA-256-hashed revisions. Optional planted demo bug. | Source manifest hash |
| 6. Verify | **Verilator** lint + **Yosys** elaboration → **cocotb + Icarus** 7-test regression → **SymbiYosys/z3** k-induction proof + covers → **Yosys** synthesis. Stops at the first failure. | Tool versions, commands, exit codes, logs, tests ↔ requirement IDs |
| 7. Diagnose & repair | Plain-English diagnosis (advisory). Repair proposes a diff as a *new* revision, capped at 3 rounds, and never edits tests. | Preserved failed revisions |
| 8. Physical | SDC draft from the approved clock, human approval bound to its hash, then **OpenROAD Flow Scripts on SKY130**: floorplan, PDN, placement, CTS, routing, GDSII, post-route antenna, KLayout DRC (FEOL + BEOL) and LVS. Multi-corner STA and equivalence are shown as NOT RUN. See [docs/physical-design-report.md](docs/physical-design-report.md). | Each check PASS / FAIL / NOT_RUN, metrics, routed-layout image, GDS (SHA-256) |
| 9. Release | Checklist per policy, qualified-human sign-off, deterministic ZIP with `manifest.json` + `sha256sums.txt`, tamper check. | Package, never "submitted" |

## Repository map

```
apps/web/        Next.js 15 app: UI, HTTP API, workflow state machine, policy gates,
                 AI agent runtime + provider adapters, release packaging (deploys to Vercel)
  src/lib/domain/   spec schema, FIFO requirement catalogue, workflow transitions, release policy
  src/lib/design/   RTL / formal-property / SDC templates
  src/lib/eda/      job contract, runner (worker → recorded → WASM → blocked), Yosys WASM adapter
  src/lib/ai/       AIProvider contract, registry, conformance, egress policy, SSRF guard, agent runtime
  evidence/         294 results from real tool runs, keyed by job-input SHA-256 (73 RTL configurations + 2 layouts)
  migrations/       PostgreSQL schema
  scripts/          evidence recorder, browser E2E, tough-case suite, asset sync
worker/          Python EDA worker: ToolAdapter implementations, sandbox, FastAPI + CLI, Dockerfile
designs/sync_fifo/  checked-in reference RTL, formal properties, cocotb regression
docs/            ADR, threat model, capabilities matrix, tough-case report, LinkedIn kit
```

## Run it locally

Prerequisites: Node 20+ and Python 3.11+. For live tools, also Verilator, Icarus Verilog, Yosys, z3 and SymbiYosys (Ubuntu 24.04: `apt install verilator iverilog yosys z3`, then SymbiYosys from tag `yosys-0.33`).

```bash
# 1) EDA worker (optional but recommended: runs the real tools live)
cd worker && pip install -e ".[dev]"
python -m devin_vlsi_worker preflight            # capability profile
WORKER_TOKEN=dev-token python -m devin_vlsi_worker serve --port 8090

# 2) Web app
cd apps/web && npm ci
WORKER_URL=http://127.0.0.1:8090 WORKER_TOKEN=dev-token npm run dev
# open http://localhost:3000 and pick the "UART receive buffer" example
```

Physical design needs a worker with ORFS + SKY130 (`worker/scripts/install-orfs.sh`, or build the worker image with `--build-arg WITH_ORFS=1`). Without a worker the app still runs the full golden path using recorded real-tool evidence (matched by exact input hash) and in-process Yosys. Anything else is reported as `BLOCKED_TOOL_UNAVAILABLE`.

Full stack with PostgreSQL and an isolated worker container: `cp .env.example .env && docker compose up --build`.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fkashyap963hvk-afk%2Fauto-vlsi&root-directory=apps%2Fweb&project-name=auto-vlsi)

1. Import the repository in Vercel and set **Root Directory = `apps/web`**. The framework is detected as Next.js.
2. Optional: add **Neon Postgres** from the Vercel Marketplace (sets `DATABASE_URL`). Without it, projects live in an ephemeral `/tmp` database and the UI says so.
3. Optional: set `WORKER_URL` and `WORKER_TOKEN` to a worker you host (e.g. the Docker image on a VM) for live simulation, formal and physical design on any configuration. Without one, physical results exist only for the two recorded configurations; a layout run takes ~6 minutes, longer than a Vercel function may run.
4. Optional: set `DEVIN_AI_ANTHROPIC_API_KEY` (or any `DEVIN_AI_*` key) and add the connection under **Tools & AI**. The default needs no AI account.

Or from a terminal: `cd apps/web && npx vercel --prod`.

## Tests

| Suite | Command | What it proves |
|---|---|---|
| Worker unit + real-tool integration | `cd worker && python -m pytest -q` | Reference FIFO passes lint/sim/formal/synth. The planted bug fails simulation and gives a formal counterexample. BMC is reported as bounded, never proved. Physical blocks without approved constraints or tools; with ORFS present, a real sky130hd RTL→GDS run must pass flow, STA, FEOL+BEOL DRC and LVS. Sandbox, redaction and path safety. |
| Web unit/integration | `cd apps/web && npm test` | Template = reference RTL byte for byte. Workflow and approval gates, release policy, golden path with real recorded evidence, repair limit, deterministic export + tamper detection, cross-user isolation. AI layer: SSRF guard, egress policy, provider swap (mock ↔ local OpenAI-compatible server), conformance, no secret leakage, provider-neutral imports. |
| Browser E2E | `npx tsx scripts/e2e-golden-path.ts` | Full golden path in Chromium, including planted bug → diagnosis → repair → sign-off → export → verify. |
| Tough cases | `npx tsx scripts/tough-cases.ts --out ../../docs/tough-cases-report.md` | Adversarial requirements and abuse cases against a running deployment. See [docs/tough-cases-report.md](docs/tough-cases-report.md). |

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for what was run, the results, and what is not done.

## Honesty rules built into the product

- Pass/fail comes only from tool exit codes and parsed reports, never from model prose.
- A check that did not run never shows green. Recorded results are labelled *recorded*, with the original tool versions.
- Formal statuses are distinct: `PROVED`, `BOUNDED_PASS_ONLY`, `COUNTEREXAMPLE_FOUND`, `UNKNOWN`, `TIMEOUT`, `NOT_RUN`.
- Synthesis cell counts are labelled as technology-independent estimates.
- Public-PDK results are prototype checks. `SUBMITTED` and `PROVIDER_ACCEPTED` are unreachable states.

More: [architecture decision](docs/adr/0001-architecture.md) · [threat model](docs/threat-model.md) · [capabilities matrix](docs/capabilities.md).

## Licenses of the toolchain

Verilator (LGPL-3.0 / Artistic-2.0), Icarus Verilog (GPL-2.0), Yosys and SymbiYosys (ISC), z3 (MIT), cocotb (BSD-3-Clause), YoWASP Yosys (ISC), PGlite (Apache-2.0), Next.js (MIT). Tools are invoked as separate programs, not linked. No PDK data is included in this repository.
