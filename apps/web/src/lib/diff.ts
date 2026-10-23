/** Minimal line diff (LCS) producing unified-style hunks for showing repair proposals. */
export function unifiedDiff(a: string, b: string, nameA = "a", nameB = "b", context = 2): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: { t: " " | "-" | "+"; s: string; ai: number; bi: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push({ t: " ", s: x[i], ai: i++, bi: j++ });
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push({ t: "+", s: y[j], ai: i, bi: j++ });
    else ops.push({ t: "-", s: x[i], ai: i++, bi: j });
  }
  const out = [`--- ${nameA}`, `+++ ${nameB}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === " ") {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length && (ops[end].t !== " " || ops.slice(end, end + context * 2 + 1).some((o) => o.t !== " "))) end++;
    end = Math.min(ops.length, end + context);
    const hunk = ops.slice(start, end);
    out.push(`@@ -${hunk[0].ai + 1} +${hunk[0].bi + 1} @@`);
    for (const o of hunk) out.push(`${o.t}${o.s}`);
    k = end;
  }
  return out.join("\n");
}
