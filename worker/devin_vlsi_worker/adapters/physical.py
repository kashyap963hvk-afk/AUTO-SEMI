"""OpenROAD Flow Scripts (ORFS) physical-design adapter: RTL -> GDSII on a public PDK.

Steps, each recorded with its command, exit code and log:
  1. flow  : ORFS `make` (synthesis, floorplan, PDN, placement, CTS, routing, fill, final report, GDS)
  2. drc   : KLayout DRC with the platform deck (front-end checks enabled if requested)
  3. lvs   : KLayout LVS of the final GDS against the final netlist
The stage passes only if every required sign-off check passes. The adapter never
writes a GDS, metric or verdict of its own.

Known defects in the open-source sky130hd collateral used here, and what this adapter does
about them (always listed in the result's limitations):
  * the platform CDL has unparseable cells the design does not use (a malformed
    macro_sparecell, value-less "short" resistors in conb_1): LVS gets the CDL pruned
    to the subcircuits the routed netlist instantiates;
  * the LVS deck calls report() instead of report_lvs(), so no LVS database is written;
  * the LVS deck defines the substrate as GDS layer 236/0, absent from the layouts, which
    leaves NMOS bulks floating: substrate is set to chip extent minus n-well;
  * fill and tap cells have no devices: empty circuits are purged on the schematic side.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import os
import re
import time
from pathlib import Path

from .. import sandbox
from ..models import Artifact, Finding, Job, StageStatus, StepResult
from ..sandbox import ExecResult
from .base import AdapterOutput, Capability, ToolAdapter

SUPPORTED_PLATFORMS = {"sky130hd", "gf180"}
_NUM = r"(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)"


def _env_path(name: str) -> str | None:
    value = os.environ.get(name)
    return value if value and Path(value).exists() else None


def tool_paths() -> dict[str, str | None]:
    flow = os.environ.get("ORFS_FLOW_HOME")
    return {
        "flow_home": flow if flow and (Path(flow) / "Makefile").exists() else None,
        "openroad": _env_path("ORFS_OPENROAD") or sandbox.which("openroad"),
        "yosys": _env_path("ORFS_YOSYS") or sandbox.which("yosys"),
        "klayout": _env_path("ORFS_KLAYOUT") or sandbox.which("klayout"),
    }


def parse_finish_report(text: str) -> dict:
    def grab(pattern: str) -> float | None:
        m = re.search(pattern, text, re.I | re.M)
        return float(m.group(1)) if m else None

    power = re.search(r"^Total\s+" + r"\s+".join([_NUM] * 4), text, re.M)
    return {
        "tns_ns": grab(r"^tns " + _NUM),
        "wns_ns": grab(r"^wns " + _NUM),
        "worst_slack_ns": grab(r"^worst slack " + _NUM),
        "critical_path_delay_ns": grab(r"finish critical path delay\n-+\n" + _NUM),
        "critical_path_slack_ns": grab(r"finish critical path slack\n-+\n" + _NUM),
        "setup_violations": grab(r"setup violation count " + _NUM),
        "hold_violations": grab(r"hold violation count " + _NUM),
        "max_slew_violations": grab(r"max slew violation count " + _NUM),
        "max_cap_violations": grab(r"max cap violation count " + _NUM),
        "max_fanout_violations": grab(r"max fanout violation count " + _NUM),
        "power_total_w": float(power.group(4)) if power else None,
    }


def parse_metrics(work: Path, platform: str, top: str) -> dict:
    base = f"{platform}/{top}/base"
    rep, logs = work / "reports" / base, work / "logs" / base
    read = lambda p: p.read_text(errors="replace") if p.exists() else ""  # noqa: E731
    m = parse_finish_report(read(rep / "6_finish.rpt"))
    report_log = read(logs / "6_report.log")
    area = re.search(r"Design area " + _NUM + r" u\^2 " + _NUM + "% utilization", report_log)
    m["design_area_um2"] = float(area.group(1)) if area else None
    m["utilization_pct"] = float(area.group(2)) if area else None
    irs = [float(x) for x in re.findall(r"Worstcase IR drop:\s*" + _NUM, report_log)]
    m["worst_ir_drop_v"] = max(irs) if irs else None
    route_log = read(logs / "5_3_route.log")
    drv = re.findall(r"Number of violations = (\d+)", route_log)
    m["route_drc_violations"] = int(drv[-1]) if drv else None
    grt_ant = re.findall(r"Found (\d+) net violations", read(logs / "5_1_grt.log"))
    m["global_route_antenna_net_violations"] = int(grt_ant[-1]) if grt_ant else None
    stat = read(rep / "synth_stat.txt")
    cells = re.search(r"Number of cells:\s+(\d+)", stat)
    m["synth_cells"] = int(cells.group(1)) if cells else None
    return m


def parse_antenna(text: str) -> tuple[int | None, int | None]:
    net = re.findall(r"Found (\d+) net violations", text)
    pin = re.findall(r"Found (\d+) pin violations", text)
    return (int(net[-1]) if net else None, int(pin[-1]) if pin else None)


def prune_cdl(platform_cdl: str, netlist_v: str, prefix: str) -> tuple[str, list[str]]:
    """Keep only the subcircuits the routed netlist instantiates (transitively)."""
    used = set(re.findall(rf"^\s*({prefix}\w+)\s+\S+\s*\(", netlist_v, re.M))
    blocks = re.findall(r"(\.SUBCKT\s+(\S+).*?\.ENDS[^\n]*\n)", platform_cdl, flags=re.S | re.I)
    defs = {name: body for body, name in blocks}
    keep: set[str] = set()
    stack = [u for u in used if u in defs]
    while stack:
        name = stack.pop()
        if name in keep:
            continue
        keep.add(name)
        stack += [r for r in re.findall(r"/\s*(\S+)\s*$", defs[name], re.M) if r in defs]
    missing = sorted(u for u in used if u not in defs)
    return "".join(defs[n] for n in sorted(keep)), missing


LVS_PATCHES = [
    (re.compile(r"^(\s*)report\(\$report_file\)", re.M), r"\1report_lvs($report_file)"),
    (re.compile(r"^SUB = polygons\(236, 0\)", re.M), "# Auto-VLSI: substrate = chip extent minus n-wells (layer 236/0 is absent)\nSUB = extent - NWELL"),
    (re.compile(r"^netlist\.simplify$", re.M), "netlist.simplify\n# Auto-VLSI: fill/tap cells have no devices\nschematic.purge"),
]


def patch_lvs_deck(deck: str) -> str:
    for pattern, repl in LVS_PATCHES:
        deck, n = pattern.subn(repl, deck, count=1)
        if n != 1:
            raise ValueError(f"LVS deck does not have the expected structure ({pattern.pattern}); refusing to guess")
    return deck


# FEOL rules in the platform deck do not finish in practical time in KLayout's deep
# (hierarchical) mode (licon.12/13 ran >35 min on a 3k-cell block). Tiled flat mode runs the
# whole deck in ~2 min. The tile border must exceed the largest rule distance (licon.12: 5.7 um).
DRC_FEOL_PATCHES = [
    (re.compile(r"^FEOL\s*=\s*false", re.M), "FEOL    = true # enabled by Auto-VLSI"),
    (re.compile(r"^deep$", re.M), "# Auto-VLSI: tiled flat mode instead of deep mode\nflat"),
    (re.compile(r"^tiles\([^)]*\)", re.M), "tiles(60.um)"),
    (re.compile(r"^tile_borders\([^)]*\)", re.M), "tile_borders(10.um)"),
]


def patch_drc_deck(deck: str, feol: bool) -> str:
    if not feol:
        return deck
    for pattern, repl in DRC_FEOL_PATCHES:
        deck, n = pattern.subn(repl, deck, count=1)
        if n != 1:
            raise ValueError(f"DRC deck does not have the expected structure ({pattern.pattern}); refusing to guess")
    return deck


def feol_rule_names(deck: str) -> set[str]:
    """Rule names the deck outputs inside its `if FEOL ... end #FEOL` block."""
    m = re.search(r"^if FEOL\b(.*?)^end #FEOL", deck, re.M | re.S)
    return set(re.findall(r'\.output\("([^"]+)"', m.group(1))) if m else set()


class OrfsPhysical(ToolAdapter):
    tool = "openroad-flow-scripts"
    executable = "openroad"
    version_args = ("-version",)
    version_pattern = r"(\d+\.\d+-\d+-g[0-9a-f]+|\d+\.\d+[^\s]*)"

    def tool_version(self) -> str | None:
        paths = tool_paths()
        if not paths["openroad"]:
            return None
        res = sandbox.run([paths["openroad"], "-version"], cwd=Path("/tmp"), timeout_s=30, memory_mb=4096, max_output_bytes=10_000)
        m = re.search(self.version_pattern, res.stdout + res.stderr)
        return f"OpenROAD {m.group(1)}" if m else None

    def flow_home(self) -> Path | None:
        home = tool_paths()["flow_home"]
        return Path(home) if home else None

    def probe_capabilities(self) -> Capability:
        paths = tool_paths()
        version = self.tool_version()
        cap = Capability(tool=self.tool, available=bool(version and paths["flow_home"] and paths["yosys"] and paths["klayout"]), version=version, path=paths["openroad"])
        if not paths["flow_home"]:
            cap.notes.append("ORFS_FLOW_HOME is not set or has no Makefile: physical implementation is blocked.")
        else:
            platforms = sorted(p.name for p in (Path(paths["flow_home"]) / "platforms").glob("*") if p.name in SUPPORTED_PLATFORMS)
            cap.notes.append(f"platforms present: {platforms or 'none'}")
        if not paths["klayout"]:
            cap.notes.append("KLayout missing: GDS merge, DRC and LVS cannot run.")
        cap.notes.append("Public-PDK DRC/LVS results are prototype checks, not foundry sign-off.")
        return cap

    def preflight(self, job: Job) -> tuple[StageStatus, list[Finding]] | None:
        findings: list[Finding] = []
        platform = job.options.get("platform")
        if not job.options.get("clock_period_ns") or not job.options.get("constraints_approved"):
            findings.append(Finding(severity="error", code="TIMING_CONSTRAINTS_INCOMPLETE", message="clock period is unknown or the SDC draft has not been approved", tool=self.tool))
            return StageStatus.BLOCKED_MISSING_CONSTRAINTS, findings
        if "constraints/approved.sdc" not in job.files:
            findings.append(Finding(severity="error", code="TIMING_CONSTRAINTS_INCOMPLETE", message="no approved SDC file was supplied", tool=self.tool))
            return StageStatus.BLOCKED_MISSING_CONSTRAINTS, findings
        if platform not in SUPPORTED_PLATFORMS:
            findings.append(Finding(severity="error", code="PDK_UNCONFIRMED", message=f"target platform {platform!r} is not a supported, confirmed ORFS platform", tool=self.tool))
            return StageStatus.BLOCKED_MISSING_CONSTRAINTS, findings
        cap = self.probe_capabilities()
        flow = self.flow_home()
        if not cap.available or not flow or not (flow / "platforms" / platform / "config.mk").exists():
            findings.append(Finding(severity="error", code="TOOL_UNAVAILABLE", message=f"OpenROAD/ORFS/KLayout or the {platform} platform collateral is not installed on this worker", tool=self.tool))
            return StageStatus.BLOCKED_TOOL_UNAVAILABLE, findings
        return None

    def build_command(self, job: Job, run_dir: Path) -> list[str]:
        paths = tool_paths()
        work = run_dir / "orfs"
        return [
            "make", "-C", str(self.flow_home()), f"DESIGN_CONFIG={work / 'config.mk'}", f"WORK_HOME={work}",
            f"YOSYS_CMD={paths['yosys']}", f"OPENROAD_EXE={paths['openroad']}", f"KLAYOUT_CMD={paths['klayout']}",
        ]

    def _write_config(self, job: Job, run_dir: Path) -> None:
        work = run_dir / "orfs"
        work.mkdir(exist_ok=True)
        verilog = " ".join(str(run_dir / f) for f in job.filelist)
        lines = [
            f"export DESIGN_NAME = {job.top}",
            f"export DESIGN_NICKNAME = {job.top}",
            f"export PLATFORM = {job.options['platform']}",
            f"export VERILOG_FILES = {verilog}",
            f"export SDC_FILE = {run_dir / 'constraints' / 'approved.sdc'}",
            f"export CORE_UTILIZATION = {int(job.options.get('core_utilization', 40))}",
            f"export PLACE_DENSITY = {float(job.options.get('place_density', 0.6))}",
            # ORFS defaults to a 1 um die-to-core margin, but sky130hd met3 IO pins are 0.8 um deep, so a
            # pin can land within 25 nm of a core-edge PDN via stack (KLayout DRC m3.2). Keep them apart.
            f"export CORE_MARGIN = {float(job.options.get('core_margin_um', 1.0))}",
        ]
        # Parameters are fixed in the RTL file itself; ORFS reads it as-is.
        (work / "config.mk").write_text("\n".join(lines) + "\n")

    def _step(self, label: str, res: ExecResult, status: StageStatus, version: str | None, extra_log: str = "") -> StepResult:
        s = self.step(res, status)
        s.tool = f"{self.tool}:{label}"
        s.version = version
        if extra_log:
            s.stdout = (s.stdout + f"\n--- {label} log (tail) ---\n" + extra_log[-30_000:]).strip()
        return s

    def run(self, job: Job, run_dir: Path, version: str | None) -> AdapterOutput:
        self.validate_inputs(job)
        paths = tool_paths()
        platform, top = job.options["platform"], job.top
        work = run_dir / "orfs"
        base = f"{platform}/{top}/base"
        budget, started = job.limits.timeout_s, time.monotonic()
        remaining = lambda: max(30, int(budget - (time.monotonic() - started)))  # noqa: E731
        lim = dict(memory_mb=max(job.limits.memory_mb, 8192), max_output_bytes=job.limits.max_output_bytes)
        steps: list[StepResult] = []
        findings: list[Finding] = []
        checks: dict[str, str] = {}
        self._write_config(job, run_dir)

        # 1. RTL -> GDS
        res = sandbox.run(self.build_command(job, run_dir), cwd=run_dir, timeout_s=int(budget * 0.75), **lim)
        gds = work / "results" / base / "6_final.gds"
        flow_ok = res.exit_code == 0 and gds.exists()
        steps.append(self._step("flow", res, StageStatus.PASS if flow_ok else StageStatus.TIMEOUT if res.timed_out else StageStatus.FAIL, version))
        if not flow_ok:
            findings.append(Finding(severity="error", code="FLOW_FAILED", message="ORFS did not complete to a final GDS; see the flow log", tool=self.tool))
            return AdapterOutput(step=steps[0], findings=findings, extra={"steps": steps, "metrics": {"checks": {"flow": "FAIL"}}})
        checks["flow"] = "PASS"
        metrics = parse_metrics(work, platform, top)

        def judge(name: str, value: float | int | None, ok: bool, msg: str) -> None:
            if value is None:
                checks[name] = "NOT_REPORTED"
                findings.append(Finding(severity="error", code=f"{name.upper()}_NOT_REPORTED", message=f"{msg}: not found in the ORFS reports", tool=self.tool))
            elif ok:
                checks[name] = "PASS"
            else:
                checks[name] = "FAIL"
                findings.append(Finding(severity="error", code=f"{name.upper()}_FAILED", message=f"{msg}: {value}", tool=self.tool))

        judge("sta_setup", metrics["setup_violations"], metrics["setup_violations"] == 0 and (metrics["wns_ns"] or 0) >= 0, "setup violations (typical corner)")
        judge("sta_hold", metrics["hold_violations"], metrics["hold_violations"] == 0, "hold violations (typical corner)")
        drv = [metrics[k] for k in ("max_slew_violations", "max_cap_violations", "max_fanout_violations")]
        judge("electrical_rules", None if None in drv else sum(drv), not any(drv), "max slew/cap/fanout violations")
        judge("route_drc", metrics["route_drc_violations"], metrics["route_drc_violations"] == 0, "detailed-router DRC violations")
        # ORFS checks antennas after global routing only; check the final detailed-routed database too.
        odb = work / "results" / base / "6_final.odb"
        (run_dir / "antenna.tcl").write_text(f"read_db {odb}\ncheck_antennas\nexit\n")
        res = sandbox.run([paths["openroad"], "-no_init", "-no_splash", "-exit", str(run_dir / "antenna.tcl")], cwd=run_dir, timeout_s=min(remaining(), 600), **lim)
        net_v, pin_v = parse_antenna(res.stdout + res.stderr)
        metrics["antenna_net_violations"], metrics["antenna_pin_violations"] = net_v, pin_v
        ant = None if net_v is None or pin_v is None else net_v + pin_v
        steps.append(self._step("antenna (post-route)", res, StageStatus.PASS if ant == 0 else StageStatus.FAIL, version))
        judge("antenna", ant, ant == 0, "post-route antenna violations")

        # 2. KLayout DRC
        platform_dir = self.flow_home() / "platforms" / platform
        deck = next(iter(sorted((platform_dir / "drc").glob("*.lydrc"))), None)
        if deck:
            feol = bool(job.options.get("drc_feol", False))
            try:
                text = patch_drc_deck(deck.read_text(), feol)
            except ValueError as e:
                findings.append(Finding(severity="warning", code="DRC_FEOL_NOT_RUN", message=f"{e}; running the deck as shipped (FEOL rules off)", tool=self.tool))
                text, feol = deck.read_text(), False
            (run_dir / "drc.lydrc").write_text(text)
            rdb = run_dir / "drc.lyrdb"
            res = sandbox.run([paths["klayout"], "-zz", "-rd", f"in_gds={gds}", "-rd", f"report_file={rdb}", "-r", str(run_dir / "drc.lydrc")], cwd=run_dir, timeout_s=min(remaining(), int(budget * 0.5)), **lim)
            count = len(re.findall(r"<item>", rdb.read_text(errors="replace"))) if rdb.exists() else None
            cats = sorted(set(re.findall(r"<item>.*?<category>'?([^<']+)'?</category>", rdb.read_text(errors="replace"), re.S))) if rdb.exists() else []
            metrics["klayout_drc_violations"] = count
            metrics["klayout_drc_scope"] = "FEOL + BEOL + off-grid (tiled flat mode)" if feol else "BEOL + off-grid only (FEOL disabled)"
            metrics["klayout_drc_categories"] = cats[:30]
            if feol and rdb.exists() and not res.timed_out and res.exit_code == 0:
                feol_hits = sorted(set(cats) & feol_rule_names(text))
                metrics["klayout_drc_feol_categories"] = feol_hits
                metrics["_feol_verdict"] = "FAIL" if feol_hits else "PASS"
            elif feol:
                metrics["_feol_verdict"] = "NOT_REPORTED"
            status = StageStatus.TIMEOUT if res.timed_out else StageStatus.PASS if (res.exit_code == 0 and count == 0) else StageStatus.FAIL
            steps.append(self._step("drc", res, status, version))
            judge("klayout_drc", count if not res.timed_out else None, count == 0 and res.exit_code == 0, f"KLayout DRC violations ({metrics['klayout_drc_scope']})")
        else:
            checks["klayout_drc"] = "NOT_RUN"
            findings.append(Finding(severity="error", code="DRC_NOT_RUN", message=f"no KLayout DRC deck for {platform}", tool=self.tool))

        # 3. KLayout LVS
        lvs_deck = next(iter(sorted((platform_dir / "lvs").glob("*.lylvs"))), None)
        cdl_dir = platform_dir / "cdl"
        platform_cdl = next(iter(sorted(cdl_dir.glob("*.cdl"))), None) if cdl_dir.exists() else None
        if lvs_deck and platform_cdl:
            try:
                netlist_v = (work / "results" / base / "6_final.v").read_text()
                pruned, missing = prune_cdl(platform_cdl.read_text(errors="replace"), netlist_v, prefix=f"{platform.replace('hd', '')}_fd_sc_hd__" if platform == "sky130hd" else "")
                (run_dir / "lvs_cells.cdl").write_text(pruned)
                concat = work / "objects" / base / "6_final_concat.cdl"
                res = sandbox.run(self.build_command(job, run_dir) + [f"CDL_FILE={run_dir / 'lvs_cells.cdl'}", str(concat)], cwd=run_dir, timeout_s=min(remaining(), 600), **lim)
                if not concat.exists():
                    raise RuntimeError("ORFS did not write the final CDL netlist")
                (run_dir / "lvs.lylvs").write_text(patch_lvs_deck(lvs_deck.read_text()))
                lvsdb = run_dir / "lvs.lvsdb"
                res = sandbox.run([paths["klayout"], "-b", "-rd", f"in_gds={gds}", "-rd", f"cdl_file={concat}", "-rd", f"report_file={lvsdb}", "-rd", f"target_netlist={run_dir / 'extracted.cir'}", "-r", str(run_dir / "lvs.lylvs")], cwd=run_dir, timeout_s=min(remaining(), int(budget * 0.3)), **lim)
                out = res.stdout + res.stderr
                matched = "Congratulations! Netlists match" in out
                metrics["lvs"] = "MATCH" if matched else ("MISMATCH" if "Netlists don't match" in out else "ERROR")
                metrics["lvs_missing_cells"] = missing
                steps.append(self._step("lvs", res, StageStatus.PASS if matched else StageStatus.TIMEOUT if res.timed_out else StageStatus.FAIL, version))
                judge("lvs", metrics["lvs"], matched and not missing, "LVS result")
            except (OSError, ValueError, RuntimeError) as e:
                checks["lvs"] = "ERROR"
                findings.append(Finding(severity="error", code="LVS_ERROR", message=str(e), tool=self.tool))
        else:
            checks["lvs"] = "NOT_RUN"
            findings.append(Finding(severity="error", code="LVS_NOT_RUN", message=f"no LVS deck or CDL for {platform}", tool=self.tool))

        if "klayout_drc" in checks:
            checks["klayout_drc_feol"] = metrics.pop("_feol_verdict", "NOT_RUN")
        checks["equivalence_check"] = "NOT_RUN"
        checks["multi_corner_sta"] = "NOT_RUN"
        metrics["checks"] = checks
        metrics["clock_period_ns"] = job.options.get("clock_period_ns")
        metrics["gds_bytes"] = gds.stat().st_size
        metrics["gds_sha256"] = hashlib.sha256(gds.read_bytes()).hexdigest()
        required = ["flow", "sta_setup", "sta_hold", "electrical_rules", "route_drc", "antenna", "klayout_drc", "lvs"]
        passed = all(checks.get(c) == "PASS" for c in required)
        steps[0].status = StageStatus.PASS if passed else StageStatus.FAIL
        return AdapterOutput(step=steps[0], findings=findings, extra={"steps": steps, "metrics": metrics, "stage_status": StageStatus.PASS if passed else StageStatus.FAIL})

    def parse_results(self, job: Job, run_dir: Path, res: ExecResult) -> AdapterOutput:  # pragma: no cover - run() is overridden
        raise NotImplementedError

    def collect_artifacts(self, job: Job, run_dir: Path) -> list[Path]:
        base = run_dir / "orfs"
        found = []
        for pattern in ("reports/*/*/base/final_routing.webp", "reports/*/*/base/final_placement.webp", "reports/*/*/base/6_finish.rpt", "results/*/*/base/6_final.gds"):
            found += sorted(base.glob(pattern))
        return found


def binary_artifact(path: Path, run_dir: Path) -> Artifact:
    data = path.read_bytes()
    packed = gzip.compress(data, mtime=0)
    return Artifact(path=str(path.relative_to(run_dir)), sha256=hashlib.sha256(data).hexdigest(), size=len(data), content=base64.b64encode(packed).decode(), encoding="gzip+base64")


def blocked_output(tool: str, status: StageStatus) -> AdapterOutput:
    return AdapterOutput(
        step=StepResult(tool=tool, version=None, command=[], exit_code=None, status=status, duration_s=0.0, stdout="", stderr=""),
    )
