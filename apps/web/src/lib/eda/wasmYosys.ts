import type { Job, StageResult } from "./contracts";
import { jobInputHash } from "./jobs";
import { sha256 } from "../hash";

/**
 * In-process Yosys compiled to WebAssembly (@yowasp/yosys). Runs real Yosys inside
 * the web/serverless runtime, so lint-elaboration and synthesis work without a
 * worker. It does not include Verilator, a simulator or SymbiYosys.
 */
type Tree = { [name: string]: Tree | string | Uint8Array };

async function yosys(script: string, files: Record<string, string>): Promise<{ code: number; out: string; files: Tree; ms: number }> {
  const { runYosys } = await import("@yowasp/yosys");
  const chunks: string[] = [];
  const dec = new TextDecoder();
  const sink = (b: Uint8Array | null) => {
    if (b) chunks.push(dec.decode(b));
  };
  const started = Date.now();
  try {
    const tree = (await runYosys(["-q", "-l", "yosys.log", "-p", script], files, { stdout: sink, stderr: sink })) as Tree;
    return { code: 0, out: chunks.join(""), files: tree ?? {}, ms: Date.now() - started };
  } catch (e) {
    const err = e as { code?: number; files?: Tree; message?: string };
    if (typeof err.code === "number") return { code: err.code, out: chunks.join(""), files: err.files ?? {}, ms: Date.now() - started };
    throw e;
  }
}

export async function wasmVersion(): Promise<string> {
  const mod = await import("@yowasp/yosys");
  return `yowasp-yosys ${mod.version}`;
}

function flatFiles(job: Job): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [p, c] of Object.entries(job.files)) flat[p.split("/").pop()!] = c;
  return flat;
}

function logText(t: Tree): string {
  const v = t["yosys.log"];
  return typeof v === "string" ? v : v instanceof Uint8Array ? new TextDecoder().decode(v) : "";
}

function findings(log: string) {
  const out: StageResult["findings"] = [];
  for (const line of log.split("\n")) {
    if (line.startsWith("ERROR:")) out.push({ severity: "error", code: "YOSYS_ERROR", message: line.slice(6).trim(), tool: "yosys" });
    else if (line.startsWith("Warning:")) out.push({ severity: "warning", code: "YOSYS_WARNING", message: line.slice(8).trim(), tool: "yosys" });
  }
  return out;
}

function chparam(job: Job): string {
  const sets = Object.entries(job.parameters).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `-set ${k} ${v}`).join(" ");
  return sets ? `chparam ${sets} ${job.top}; ` : "";
}

export function parseStat(text: string) {
  const cells: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const n = line.match(/^\s+Number of ([a-z ]+):\s+(\d+)\s*$/);
    if (n) {
      counts[n[1].trim().replace(/ /g, "_")] = Number(n[2]);
      continue;
    }
    // Yosys 0.33 style: "     $_AND_    5"; newer style: "        5   $_AND_"
    const a = line.match(/^\s+(\$\S+|\S+_)\s+(\d+)\s*$/);
    const b = line.match(/^\s+(\d+)\s+(\$\S+)\s*$/);
    if (a) cells[a[1]] = Number(a[2]);
    else if (b) cells[b[2]] = Number(b[1]);
    const total = line.match(/^\s+(\d+)\s+cells\s*$/);
    if (total) counts.cells = Number(total[1]);
  }
  const seq = Object.entries(cells).filter(([c]) => /DFF|LATCH/i.test(c)).reduce((s, [, n]) => s + n, 0);
  const latches = Object.entries(cells).filter(([c]) => /LATCH/i.test(c)).reduce((s, [, n]) => s + n, 0);
  const total = counts.cells ?? Object.values(cells).reduce((s, n) => s + n, 0);
  return {
    cells_total: total,
    sequential_cells: seq,
    combinational_cells: total - seq,
    latches,
    cell_types: Object.fromEntries(Object.entries(cells).sort(([a], [b]) => a.localeCompare(b))),
    area_basis: "Yosys generic gate library (no Liberty file): technology-independent cell count, not area in um^2",
  };
}

function base(job: Job, version: string, started: string) {
  return {
    schema_version: "1.0" as const,
    job_id: job.job_id,
    stage: job.stage,
    input_hash: jobInputHash(job),
    started_at: started,
    finished_at: new Date().toISOString(),
    execution: { mode: "live-wasm" as const, runtime: "Yosys compiled to WebAssembly, running in the web server process", tool_versions: { yosys: version } },
    tests: [],
    properties: [],
    formal_status: null,
  };
}

export async function wasmLint(job: Job): Promise<StageResult> {
  const started = new Date().toISOString();
  const version = await wasmVersion();
  const reads = job.filelist.map((f) => `read_verilog -sv ${f.split("/").pop()}`).join("; ");
  const script = `${reads}; ${chparam(job)}hierarchy -check -top ${job.top}; proc; check -assert`;
  const r = await yosys(script, flatFiles(job));
  const log = logText(r.files) || r.out;
  const f = findings(log + "\n" + r.out);
  const yosysStatus = r.code === 0 && !f.length ? "PASS" : "FAIL";
  const status = yosysStatus === "FAIL" ? "FAIL" : "BLOCKED_TOOL_UNAVAILABLE";
  return {
    ...base(job, version, started),
    status,
    summary:
      status === "FAIL"
        ? `Yosys elaboration found ${f.filter((x) => x.severity === "error").length} error(s), ${f.filter((x) => x.severity === "warning").length} warning(s)`
        : "Yosys elaboration passed; Verilator lint is not available on this deployment, so the lint stage is incomplete",
    duration_s: r.ms / 1000,
    steps: [
      { tool: "verilator", version: null, command: [], exit_code: null, status: "BLOCKED_TOOL_UNAVAILABLE", duration_s: 0, stdout: "", stderr: "Verilator is not installed in this runtime. Connect an EDA worker to run it.", truncated: false },
      { tool: "yosys", version, command: ["yosys", "-q", "-p", script], exit_code: r.code, status: yosysStatus, duration_s: r.ms / 1000, stdout: log.slice(-60000), stderr: "", truncated: log.length > 60000 },
    ],
    findings: [
      ...f,
      ...(status === "BLOCKED_TOOL_UNAVAILABLE" ? [{ severity: "error" as const, code: "TOOL_UNAVAILABLE", message: "Verilator lint not run in this runtime", tool: "verilator" }] : []),
    ],
    metrics: {},
    artifacts: [],
    limitations: ["Yosys parsing is a SystemVerilog subset and is not a substitute for a dedicated linter."],
  };
}

export async function wasmSynth(job: Job): Promise<StageResult> {
  const started = new Date().toISOString();
  const version = await wasmVersion();
  const reads = job.filelist.map((f) => `read_verilog -sv ${f.split("/").pop()}`).join("; ");
  const script = `${reads}; ${chparam(job)}synth -top ${job.top}; check; tee -q -o stat.txt stat; write_verilog -noattr netlist.v`;
  const r = await yosys(script, flatFiles(job));
  const get = (n: string) => {
    const v = r.files[n];
    return typeof v === "string" ? v : v instanceof Uint8Array ? new TextDecoder().decode(v) : null;
  };
  const stat = get("stat.txt");
  const netlist = get("netlist.v");
  const log = logText(r.files) || r.out;
  const f = findings(log);
  const metrics = stat ? parseStat(stat) : {};
  let status: StageResult["status"] = r.code === 0 ? "PASS" : "FAIL";
  if (status === "PASS" && (!netlist || !stat)) {
    status = "ERROR";
    f.push({ severity: "error", code: "NO_NETLIST", message: "synthesis produced no netlist/statistics", tool: "yosys" });
  } else if (status === "PASS" && (metrics as { latches?: number }).latches) {
    status = "FAIL";
    f.push({ severity: "error", code: "LATCH_INFERRED", message: "latch cell(s) inferred", tool: "yosys" });
  }
  const m = metrics as { cells_total?: number; sequential_cells?: number; latches?: number };
  return {
    ...base(job, version, started),
    status,
    summary: status === "PASS" ? `synthesised: ${m.cells_total} generic cells, ${m.sequential_cells} sequential, ${m.latches} latches` : `synthesis ${status}`,
    duration_s: r.ms / 1000,
    steps: [{ tool: "yosys", version, command: ["yosys", "-q", "-p", script], exit_code: r.code, status, duration_s: r.ms / 1000, stdout: log.slice(-60000), stderr: "", truncated: log.length > 60000 }],
    findings: f,
    metrics,
    artifacts: [
      ...(netlist ? [{ path: "netlist.v", sha256: sha256(netlist), size: Buffer.byteLength(netlist), content: netlist.length < 256000 ? netlist : null }] : []),
      ...(stat ? [{ path: "stat.txt", sha256: sha256(stat), size: Buffer.byteLength(stat), content: stat }] : []),
    ],
    limitations: ["Generic Yosys gates without a Liberty file: cell counts are estimates, not silicon area, timing or power."],
  };
}
