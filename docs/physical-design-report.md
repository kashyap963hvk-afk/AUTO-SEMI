# Physical design report (RTL → GDSII on SKY130)

_Recorded 2026-10-23 in this repository's container (4 CPUs, 15 GB RAM). Every number below is copied from the worker's own result JSON in `apps/web/evidence/` and is re-checked when the app runs the same inputs._

## Toolchain (exact)

| Tool | Version | Source |
|---|---|---|
| OpenROAD Flow Scripts | commit `d5cc6022` | git, sparse checkout of `flow/` |
| OpenROAD | 2.0-12381-g01bba3695 | litex-hub conda |
| Yosys (ORFS synthesis) | 0.38 | litex-hub conda |
| KLayout (GDS merge, DRC, LVS) | 0.28.16 | Ubuntu 24.04 apt |
| PDK | SkyWater SKY130, `sky130hd` platform as shipped with ORFS | ORFS `flow/platforms/sky130hd` |

Install it the same way with `worker/scripts/install-orfs.sh`.

## The tough project: 32 × 32-bit FIFO, async active-low reset, 200 MHz

Asked for in plain English: *"I need a FIFO that stores 32 values of 32 bits each between a DMA engine and a CPU, with an asynchronous active-low reset, running at 200 MHz on SKY130. It's a prototype."*

Before layout, the RTL passed Verilator lint, 7/7 cocotb tests, a SymbiYosys k-induction proof and Yosys synthesis with 0 latches. A planted off-by-one `full` bug was caught by simulation first and fixed in a new revision.

**Overall result: PASS on every required check.** Run time was 293 s: flow 174 s, DRC 105 s, LVS 14 s, antenna 1 s.

| Check | Result |
|---|---|
| RTL → GDSII flow (synthesis, floorplan, PDN, placement, CTS, global + detailed routing, fill, GDS merge) | PASS |
| Setup timing, tt_025C_1v80 only | PASS. WNS 0, TNS 0, worst slack **+0.08 ns** at a 5.00 ns clock, critical path 3.82 ns |
| Hold timing, tt only | PASS, 0 violations |
| Max slew / cap / fanout | PASS, 0 violations |
| Detailed-router DRC | PASS, 0 violations |
| Antenna, re-checked on the final detail-routed database | PASS, 0 nets and 0 pins |
| KLayout DRC: FEOL + BEOL + off-grid (ORFS open deck, tiled flat mode) | PASS, 0 markers |
| LVS: KLayout, layout vs final netlist | PASS, "Netlists match" |
| Multi-corner STA (ss / ff) | **NOT RUN** |
| Logic equivalence: final netlist vs RTL | **NOT RUN** |

Other numbers:

- Cell area: 49,822 µm² at 48% utilization.
- Power: 33.4 mW, vectorless at the tt corner.
- Worst IR drop: 15.0 mV.
- GDS: 4.8 MB.

### What this does **not** show

Read these before quoting the numbers above:

1. **The timing margin is razor-thin, and only one corner is checked.** +0.08 ns (80 ps, under 2% of the clock period) at the typical corner says nothing about the slow corner, where this design could fail at 200 MHz. ORFS here ships only the tt library for sky130hd.
2. **The DRC is the open-source ORFS deck, not the SkyWater sign-off deck.**
   - It codes 165 FEOL checks.
   - About a dozen rules are marked "not coded" in the deck itself (for example licon.3, licon.9, dnwell.6, licon.11b/11d and several vpp rules).
   - Density and seal-ring rules are not checked.
3. **No equivalence check.** Nothing formally shows that the routed netlist equals the RTL (eqy is not installed). LVS shows the layout matches the *netlist*, not the RTL.
4. **LVS needed three documented fixes to the shipped deck**, plus a CDL pruned to the cells actually used. All are in `worker/devin_vlsi_worker/adapters/physical.py`, and the adapter refuses to run if a fix does not apply exactly:
   - `report_lvs` instead of `report`;
   - substrate = chip extent minus n-well;
   - purge device-less fill/tap cells.
5. **This is a block, not a chip.** It has no pad ring, ESD, seal ring or packaging, and nothing was submitted to any foundry or shuttle.

## A second configuration, and a DRC failure we found and fixed

The second configuration is an 8 × 16-bit FIFO at 50 MHz.

**In the first run it FAILED KLayout DRC with 4 `m3.2` markers** (metal-3 spacing, minimum 0.30 µm). The worker's real RTL→GDS integration test failed the same way on another small die.

- **Root cause.**
  - ORFS defaults to a 1.0 µm die-to-core margin, but sky130hd met3 IO pins are 0.8 µm deep.
  - So the IO placer put an input pin at the die edge 25 nm from a core-edge power-grid via landing pad.
  - The deck counts `met3.pin` (70/16) as metal. The detailed router does not check pin-to-PDN spacing, so router DRC said 0.
- **It is not a tiling artefact.** KLayout's original deep mode reported the same 4 markers at the same coordinates.
- **Fix.** The adapter now sets `CORE_MARGIN = 4 µm` (job option `core_margin_um`). It is part of the job inputs, so it is hashed and recorded.
- **After the fix, every required check passes:**
  - worst slack +13.62 ns at a 20 ns clock;
  - 7,256 µm² at 50% utilization;
  - 0 DRC markers, LVS match, run time 101 s.
- **The integration test asserts DRC PASS.** It was not relaxed to get there.
- **Cost of the fix.** The bigger margin moved the 200 MHz layout too: slack went from +0.17 ns to +0.08 ns. Both numbers are from real runs, and only the current one is shipped.

## How we know a clean DRC is real (negative control)

FEOL DRC does not finish in practical time in KLayout's deep mode: licon.12 and licon.13 ran for more than 35 minutes on a 3k-cell block. The adapter therefore runs the deck in tiled flat mode, with 60 µm tiles and 10 µm borders. The border is larger than the widest rule distance, which is licon.12 at 5.7 µm.

To show this mode still catches violations, `worker/scripts/drc-negative-control.py` plants three FEOL errors into a copy of a routed GDS:

- diffusion 0.10 µm wide;
- poly 0.10 µm wide;
- n-well 0.30 µm wide.

The same deck in the same mode reported all three: `difftap.1`, `poly.1a`, and `nwell.1` + `nwell.2a`. On the unmodified layout it reports 0 markers.

## Running it

- **Worker test:** `ORFS_FLOW_HOME=/opt/orfs/flow ORFS_OPENROAD=… ORFS_YOSYS=… ORFS_KLAYOUT=… python -m pytest -q tests/test_eda_integration.py -k rtl_to_gds` runs a real sky130hd flow and asserts flow, STA, DRC (FEOL included) and LVS.
- **App:** connect a worker that has the ORFS variables set. Then approve the SDC in **Physical design** and press **Run physical design**.
- **Without that worker:** on Vercel, for example, only the two recorded configurations above return physical results, from recorded evidence. Every other configuration reports `BLOCKED_TOOL_UNAVAILABLE`. A Vercel function cannot run a 6-minute layout flow.
