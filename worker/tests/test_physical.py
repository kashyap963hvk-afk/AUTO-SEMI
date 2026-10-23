"""Physical adapter parsing and LVS-collateral handling, from real ORFS output (32x32 FIFO, sky130hd, 100 MHz)."""

import shutil
from pathlib import Path

import pytest

from devin_vlsi_worker.adapters.physical import feol_rule_names, parse_metrics, patch_drc_deck, patch_lvs_deck, prune_cdl

FIX = Path(__file__).parent / "fixtures" / "orfs"


@pytest.fixture()
def work(tmp_path):
    rep = tmp_path / "reports/sky130hd/sync_fifo/base"
    logs = tmp_path / "logs/sky130hd/sync_fifo/base"
    rep.mkdir(parents=True)
    logs.mkdir(parents=True)
    shutil.copy(FIX / "6_finish.rpt", rep)
    shutil.copy(FIX / "synth_stat.txt", rep)
    shutil.copy(FIX / "6_report.log", logs)
    shutil.copy(FIX / "5_3_route.log", logs)
    return tmp_path


def test_parse_real_orfs_reports(work):
    m = parse_metrics(work, "sky130hd", "sync_fifo")
    assert m["wns_ns"] == 0.0 and m["tns_ns"] == 0.0
    assert m["worst_slack_ns"] == pytest.approx(4.03)
    assert m["setup_violations"] == 0 and m["hold_violations"] == 0
    assert m["critical_path_delay_ns"] == pytest.approx(3.8693)
    assert m["design_area_um2"] == 49900 and m["utilization_pct"] == 48
    assert m["route_drc_violations"] == 0
    assert m["global_route_antenna_net_violations"] is None  # only post-route antenna counts, run as its own step
    assert m["power_total_w"] == pytest.approx(1.66e-2)
    assert m["worst_ir_drop_v"] == pytest.approx(7.24e-3)
    assert m["synth_cells"] == 3193


def test_parse_antenna():
    from devin_vlsi_worker.adapters.physical import parse_antenna

    assert parse_antenna("[INFO ANT-0002] Found 0 net violations.\n[INFO ANT-0001] Found 3 pin violations.") == (0, 3)
    assert parse_antenna("crashed") == (None, None)


def test_missing_reports_are_not_reported_as_zero(tmp_path):
    m = parse_metrics(tmp_path, "sky130hd", "sync_fifo")
    assert m["setup_violations"] is None and m["route_drc_violations"] is None and m["design_area_um2"] is None


CDL = """.SUBCKT sky130_fd_sc_hd__inv_1 A VGND VNB VPB VPWR Y
X0 Y A VGND VNB sky130_fd_pr__nfet_01v8 w=0.65 l=0.15
.ENDS
.SUBCKT sky130_fd_sc_hd__conb_1 VGND VNB VPB VPWR HI LO
rI12 VGND LO short
.ENDS
.SUBCKT sky130_fd_sc_hd__macro_sparecell VGND VNB VPB VPWR LO
XI1 VGND VNB VPB VPWR net59 LO / sky130_fd_sc_hd__conb_1
.ENDS
"""


def test_prune_cdl_keeps_only_used_cells():
    netlist = "module m();\n sky130_fd_sc_hd__inv_1 _1_ (.A(a), .Y(b));\nendmodule\n"
    out, missing = prune_cdl(CDL, netlist, "sky130_fd_sc_hd__")
    assert "inv_1" in out and "conb_1" not in out and "sparecell" not in out
    assert missing == []


def test_prune_cdl_reports_cells_without_a_schematic():
    out, missing = prune_cdl(CDL, " sky130_fd_sc_hd__nand9_1 _2_ (.A(a));", "sky130_fd_sc_hd__")
    assert missing == ["sky130_fd_sc_hd__nand9_1"]


def test_lvs_deck_patch_is_exact_or_refuses():
    deck = "if $report_file\n  report($report_file)\nend\nSUB = polygons(236, 0)\nnetlist.simplify\n"
    patched = patch_lvs_deck(deck)
    assert "report_lvs($report_file)" in patched and "SUB = extent - NWELL" in patched and "schematic.purge" in patched
    with pytest.raises(ValueError):
        patch_lvs_deck("something else entirely")


def test_drc_deck_feol_patch_is_exact_or_refuses():
    deck = "FEOL    = false # front-end-of-line checks\ntiles(1000.um)\ntile_borders(1.um)\ndeep\n"
    assert patch_drc_deck(deck, False) == deck
    patched = patch_drc_deck(deck, True)
    assert "FEOL    = true" in patched and "\nflat" in patched and "\ndeep" not in patched
    # The border must cover the largest rule distance (licon.12, 5.7 um) or tiles miss violations.
    assert "tile_borders(10.um)" in patched and "tiles(60.um)" in patched
    with pytest.raises(ValueError):
        patch_drc_deck("FEOL = false\ndeep\n", True)


def test_feol_verdict_uses_only_rules_from_the_feol_block():
    deck = 'if FEOL\n  diff.width(0.15).output("difftap.1", "x")\nend #FEOL\nif BEOL\n  m3.space(0.3).output("m3.2", "y")\nend\n'
    assert feol_rule_names(deck) == {"difftap.1"}
    assert feol_rule_names("no blocks here") == set()
