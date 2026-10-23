import { createHash, randomBytes } from "node:crypto";

/** Canonical JSON: recursively sorted keys, no whitespace. Byte-compatible with worker/devin_vlsi_worker/hashing.py. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}
