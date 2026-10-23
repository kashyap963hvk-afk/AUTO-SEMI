import { lookup } from "node:dns/promises";
import net from "node:net";
import type { ConnectionClass } from "./contracts";

/**
 * SSRF defences for user-entered model endpoints (spec 23A, acceptance test 26):
 * http(s) only, no embedded credentials, cloud metadata targets always refused,
 * private/loopback targets only when the connection is explicitly local/private,
 * DNS re-resolved before every call, and redirects never followed (see adapters).
 */

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

export type IpClass = "public" | "private" | "loopback" | "link_local" | "metadata" | "unspecified" | "reserved";

export function classifyIp(ip: string): IpClass {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (ip === "169.254.169.254" || ip === "169.254.170.2" || ip === "100.100.100.200" || ip === "192.0.0.192") return "metadata";
    if (a === 0) return "unspecified";
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link_local";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
    if (a >= 224) return "reserved";
    return "public";
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1") return "loopback";
    if (v === "::") return "unspecified";
    if (v === "fd00:ec2::254") return "metadata";
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return classifyIp(mapped[1]);
    if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return "link_local";
    if (v.startsWith("fc") || v.startsWith("fd")) return "private";
    if (v.startsWith("ff")) return "reserved";
    return "public";
  }
  return "reserved";
}

export interface EndpointCheck {
  ok: boolean;
  url?: URL;
  reason?: string;
  resolved?: { address: string; class: IpClass }[];
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

export async function checkEndpoint(raw: string, connection: ConnectionClass, resolve: Resolver = defaultResolver): Promise<EndpointCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "only http and https endpoints are allowed" };
  if (url.username || url.password) return { ok: false, reason: "credentials must not be embedded in the URL; use an API key environment variable" };
  if (url.hash) return { ok: false, reason: "URL fragments are not allowed" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA_HOSTS.has(host) || host.endsWith(".internal") && host.startsWith("metadata")) return { ok: false, reason: "cloud metadata endpoints are blocked" };
  const isPrivateMode = connection === "local_private" || connection === "self_hosted_gateway";
  if (connection === "third_party_hosted" && url.protocol !== "https:") return { ok: false, reason: "third-party hosted endpoints must use https" };

  let addresses: string[];
  try {
    addresses = net.isIP(host) ? [host] : await resolve(host);
  } catch {
    return { ok: false, reason: `could not resolve ${host}` };
  }
  if (!addresses.length) return { ok: false, reason: `could not resolve ${host}` };
  const resolved = addresses.map((address) => ({ address, class: classifyIp(address) }));
  for (const r of resolved) {
    if (r.class === "metadata" || r.class === "link_local") return { ok: false, reason: `${host} resolves to a link-local/metadata address (${r.address}), which is always blocked`, resolved };
    if (r.class === "unspecified" || r.class === "reserved") return { ok: false, reason: `${host} resolves to a reserved address (${r.address})`, resolved };
    if ((r.class === "private" || r.class === "loopback") && !isPrivateMode) {
      return { ok: false, reason: `${host} resolves to a private/loopback address (${r.address}); choose the "local/private endpoint" connection type to allow it`, resolved };
    }
  }
  if (connection === "local_private" && resolved.every((r) => r.class === "public")) {
    return { ok: false, reason: `${host} is a public address; register it as a third-party hosted API or a self-hosted gateway so the data-policy label is truthful`, resolved };
  }
  return { ok: true, url, resolved };
}

/** Only environment variables with this prefix may be referenced as provider secrets. */
export const SECRET_ENV_PATTERN = /^DEVIN_AI_[A-Z0-9_]{1,60}$/;

export function readSecret(envName: string | null | undefined): string | null {
  if (!envName) return null;
  if (!SECRET_ENV_PATTERN.test(envName)) throw new Error("secret references must name an environment variable starting with DEVIN_AI_");
  return process.env[envName] ?? null;
}
