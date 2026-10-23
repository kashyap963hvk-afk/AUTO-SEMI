# ADR 0001: Architecture for the first release

- Status: accepted
- Date: 2026-10-23
- Spec: `DEVIN_AI_VLSI_CLAUDE_CODE_SPEC.md` v1.1

## Context

The specification recommends Next.js + FastAPI + PostgreSQL + Redis + Docker EDA workers. The project owner also wants a public deployment on **Vercel**, which runs Node.js serverless functions and cannot host the EDA toolchain (Verilator, Icarus, Yosys, SymbiYosys, OpenROAD).

## Decision

1. **Two deployables, one contract.**
   - `apps/web`: Next.js 15 (App Router, TypeScript). It holds the UI, the HTTP API (spec section 27), the persisted workflow state machine, policy gates, the AI agent runtime and the release packaging. It is deployable to Vercel as-is.
   - `worker/`: Python 3 + FastAPI EDA worker. It holds the `ToolAdapter` implementations (spec section 19) and runs allowlisted tools in a bounded sandbox. It is deployed as a container (Dockerfile, docker-compose), never on Vercel.
   - The job/result JSON contract is defined twice and kept in lock-step: `worker/devin_vlsi_worker/models.py` and `apps/web/src/lib/eda/contracts.ts`. The canonical input hash is byte-identical in both languages, and tests on both sides check it.
2. **Deviation: orchestration in TypeScript, not FastAPI.** The workflow controller lives in the web tier so the whole product deploys as one Vercel project. FastAPI is used where the spec's reasons apply most: the tool-execution boundary. The workflow domain does not depend on where tools run.
3. **Tool execution backends, in order:**
   1. `live-worker`: the configured EDA worker runs the tools now;
   2. `recorded`: a result from an earlier real run whose job inputs (RTL, tests, parameters, options) hash identically, labelled as recorded, never as live;
   3. `live-wasm`: real Yosys compiled to WebAssembly (`@yowasp/yosys`) inside the serverless function, for elaboration and synthesis;
   4. `unavailable`: an explicit `BLOCKED_TOOL_UNAVAILABLE` result.
   No backend ever fabricates a result. The recorded store is produced by `npm run evidence:record`, which drives the same job builder through the real worker.
4. **Database:** PostgreSQL via `DATABASE_URL` (e.g. Neon from the Vercel Marketplace). Without it, embedded PostgreSQL (PGlite, WASM) runs the same SQL migrations. Locally it persists under `.data/`; on serverless hosts it lives in `/tmp` and is labelled *ephemeral* in the UI.
5. **No Redis queue in this release.** Checks run inside one request (`maxDuration` 300 s) and stream NDJSON progress events. A project-level running-state lock prevents duplicate launches. A durable queue is Phase 7 work, needed once physical design (minutes to hours) is enabled.
6. **RTL generation is deterministic.** A versioned template (`sync_fifo@1.0.0`) renders RTL and formal properties from the approved spec. The default configuration reproduces the checked-in reference RTL byte for byte. No language model writes RTL in this release. Repair proposals regenerate from the template and are shown as diffs for the user to apply.
7. **AI is provider-neutral (spec v1.1 section 23A).** Agents call an internal `AIProvider` contract. Adapters: deterministic mock (default, offline), OpenAI-compatible (local/self-hosted/hosted, fetch-based) and native Anthropic (the official SDK, confined to `src/lib/ai/adapters/anthropic.ts`). Routing, data-egress policy, capability gating, schema validation and provenance live in `agentRuntime.ts`, outside every adapter.
8. **Authentication:** an opaque per-browser session token in an httpOnly cookie, with SHA-256 stored server-side. Every query is owner-scoped. Use OIDC for a shared deployment.

## Consequences

- The public Vercel demo runs the full golden path with real recorded evidence for 73 configurations and live Yosys for any configuration. Simulation and formal for configurations that were never recorded need a worker, and the UI says so.
- Physical design is implemented as preflight, gating and an adapter, but it is **blocked**: no ORFS or PDK is installed in any environment used so far.
