# Supported-capabilities matrix

Status key: **Working**: implemented and exercised by tests or E2E with real tools. **Gated**: implemented, but reports blocked or not run until a prerequisite exists. **Not implemented**.

| Area | Status | Tooling / notes |
|---|---|---|
| Plain-English intake, guided one-question-at-a-time interview | Working | Mock (rule-based) analyst by default. Any configured model through the provider contract. |
| Typed, versioned spec with source/status/rationale per field; approval gate | Working | `DesignSpec` (zod). AI proposals need explicit acceptance. Critical unknowns block approval. |
| Architecture proposal + approval | Working | Deterministic, from the approved spec. Alternatives kept on record. |
| RTL generation (synchronous FIFO, WIDTH 1–64, DEPTH 2–64 power of two, 3 reset styles, 2 full-write policies) | Working | Template `sync_fifo@1.0.0`, immutable hashed revisions. |
| Lint & elaboration | Working | Verilator 5.020 `--lint-only -Wall` + Yosys 0.33 `hierarchy -check; proc; check -assert`. |
| Simulation regression | Working | cocotb 2.1.0 + Icarus Verilog 12.0. 7 tests (directed + 2000-cycle seeded random scoreboard) with requirement IDs. |
| Coverage collection | Not implemented | No coverage figures are reported. |
| UVM | Not implemented | Preflight reports it unsupported on this path. cocotb 2.x needs Verilator ≥ 5.036 (installed: 5.020). |
| Formal | Working | SymbiYosys + smtbmc/z3: k-induction proof plus cover checks. Distinct PROVED / BOUNDED_PASS_ONLY / COUNTEREXAMPLE_FOUND / UNKNOWN / TIMEOUT. Boolector crashed in preflight testing, so z3 is the default. Some 32-bit async-reset configurations exceed the 300 s / 2 GB limits (reported as TIMEOUT/ERROR). |
| Synthesis | Working | Yosys generic `synth`: cell counts, flip-flops, latch check. Not area in µm² (no Liberty file). |
| In-browser-server synthesis (no worker) | Working | `@yowasp/yosys` 0.70 in the Node runtime, including on Vercel. |
| Timing constraints | Gated | SDC draft from an approved clock. A human approves the exact SHA-256. Missing clock → `TIMING_CONSTRAINTS_INCOMPLETE`. |
| Physical design (ORFS), STA, DRC/LVS, antenna | Gated | Adapter + preflight implemented. Blocked: no OpenROAD/ORFS/PDK installed. Never produces fake GDS. |
| DFT / ATPG, I/O, packaging | Not implemented | Listed in the checklist as not applicable or a blocker, depending on policy. |
| Bounded repair loop | Working | Template-regeneration diff, user applies it, 3-round limit, failed revisions preserved. |
| Release candidate, human sign-off, deterministic ZIP, checksum verification | Working | `rtl-prototype` policy is exportable. `open-pdk-physical-prototype` is blocked until physical checks exist. |
| Provider-neutral AI: mock, OpenAI-compatible (local/private/gateway/hosted), native Anthropic | Working (mock, OpenAI-compatible tested against a local test server) / Implemented (Anthropic, not exercised: no key in CI) | Conformance tests, data-egress policy, per-role routing, provenance. |
| Foundry submission | Not implemented by design | `SUBMITTED` / `PROVIDER_ACCEPTED` are unreachable states. |
