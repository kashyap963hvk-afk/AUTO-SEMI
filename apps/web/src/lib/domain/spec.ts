import { z } from "zod";

/** Provenance and status carried by every specification field (spec section 6). */
export const FieldSource = z.enum(["user-confirmed", "imported-document", "ai-proposed", "tool-derived"]);
export const FieldStatus = z.enum(["confirmed", "proposed", "unknown", "blocked"]);
export type FieldSource = z.infer<typeof FieldSource>;
export type FieldStatus = z.infer<typeof FieldStatus>;

export const SpecField = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  unit: z.string().optional(),
  source: FieldSource,
  confidence: z.number().min(0).max(1).optional(),
  status: FieldStatus,
  rationale: z.string(),
  revision: z.number().int().min(1),
});
export type SpecField = z.infer<typeof SpecField>;

export const Requirement = z.object({
  id: z.string().regex(/^REQ-[A-Z]+-\d{3}$/),
  title: z.string(),
  statement: z.string(),
  priority: z.enum(["must", "should"]),
  status: FieldStatus,
  verification_method: z.array(z.enum(["simulation", "formal", "lint", "sta", "physical"])),
  depends_on: z.array(z.string()),
});
export type Requirement = z.infer<typeof Requirement>;

export const Port = z.object({
  name: z.string(),
  direction: z.enum(["input", "output"]),
  width: z.string(),
  description: z.string(),
});
export type Port = z.infer<typeof Port>;

export const DesignSpec = z.object({
  schema_version: z.literal("1.0"),
  project: z.object({
    name: z.string(),
    revision: z.number().int().min(1),
    intended_use: z.string(),
    top_module: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    hdl: z.literal("SystemVerilog"),
  }),
  target: z.object({ flow: z.string(), pdk: z.string(), pdk_variant: z.string() }),
  parameters: z.record(z.number().int()),
  requirements: z.array(Requirement),
  interfaces: z.array(Port),
  clocks: z.array(z.object({ name: z.string(), frequency_mhz: z.number().nullable(), status: FieldStatus })),
  resets: z.array(z.object({ name: z.string(), polarity: z.enum(["active_low", "active_high"]), synchrony: z.enum(["sync", "async"]) })),
  constraints: z.object({ timing: z.string(), area: z.string(), power: z.string() }),
  out_of_scope: z.array(z.string()),
  assumptions: z.array(z.object({ field: z.string(), value: z.string(), source: FieldSource, accepted: z.boolean() })),
  open_questions: z.array(z.object({ field: z.string(), question: z.string(), blocks: z.array(z.string()) })),
  fields: z.array(SpecField),
});
export type DesignSpec = z.infer<typeof DesignSpec>;

/** Minimal deterministic YAML emitter for the spec document (objects, arrays, scalars only). */
export function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const scalar = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v);
    return /^[A-Za-z0-9_./ -]+$/.test(s) && !/^(true|false|null|yes|no|-?\d)/i.test(s) && !s.includes(": ") ? s : JSON.stringify(s);
  };
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          const body = toYaml(item, indent + 1).trimStart();
          return `${pad}- ${body}`;
        }
        return `${pad}- ${scalar(item)}`;
      })
      .join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        if (v && typeof v === "object" && (!Array.isArray(v) || v.length > 0) && Object.keys(v).length > 0) {
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${v && typeof v === "object" ? (Array.isArray(v) ? "[]" : "{}") : scalar(v)}`;
      })
      .join("\n");
  }
  return pad + scalar(value);
}
