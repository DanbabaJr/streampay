import dns from "node:dns/promises";
import net from "node:net";

export interface SsrfCheckResult {
  safe: boolean;
  reason?: string;
  resolvedIp?: string;
}

export type DnsLookupFunction = (
  hostname: string,
  options: { all: true }
) => Promise<Array<{ address: string; family: number }>>;

/**
 * Parses an IPv4 address string in standard dotted-quad or alternative representations
 * (decimal integer, octal, hex, class A/B shorthand) into 4 octet numbers [b0, b1, b2, b3].
 * Returns null if not a valid IPv4 representation.
 */
export function parseIpv4(ip: string): [number, number, number, number] | null {
  const trimmed = ip.trim();
  if (!trimmed) return null;

  // Single integer (decimal, hex 0x..., or octal 0...)
  if (/^(?:0x[0-9a-f]+|0[0-7]+|[0-9]+)$/i.test(trimmed)) {
    const num = trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? parseInt(trimmed, 16)
      : trimmed.startsWith("0") && trimmed.length > 1 && !/[89]/.test(trimmed)
        ? parseInt(trimmed, 8)
        : parseInt(trimmed, 10);
    if (!Number.isNaN(num) && num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 0xff,
        (num >>> 16) & 0xff,
        (num >>> 8) & 0xff,
        num & 0xff,
      ];
    }
    return null;
  }

  const parts = trimmed.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const vals: number[] = [];
  for (const p of parts) {
    if (!p) return null;
    let v: number;
    if (/^0x[0-9a-f]+$/i.test(p)) {
      v = parseInt(p, 16);
    } else if (/^0[0-7]+$/.test(p)) {
      v = parseInt(p, 8);
    } else if (/^[0-9]+$/.test(p)) {
      v = parseInt(p, 10);
    } else {
      return null;
    }
    if (Number.isNaN(v) || v < 0) return null;
    vals.push(v);
  }

  // Handle BSD socket address format (1, 2, 3, or 4 parts)
  if (vals.length === 4) {
    if (vals.some((v) => v > 255)) return null;
    return [vals[0], vals[1], vals[2], vals[3]];
  } else if (vals.length === 3) {
    if (vals[0] > 255 || vals[1] > 255 || vals[2] > 0xffff) return null;
    return [vals[0], vals[1], (vals[2] >>> 8) & 0xff, vals[2] & 0xff];
  } else if (vals.length === 2) {
    if (vals[0] > 255 || vals[1] > 0xffffff) return null;
    return [vals[0], (vals[1] >>> 16) & 0xff, (vals[1] >>> 8) & 0xff, vals[1] & 0xff];
  } else if (vals.length === 1) {
    if (vals[0] > 0xffffffff) return null;
    return [
      (vals[0] >>> 24) & 0xff,
      (vals[0] >>> 16) & 0xff,
      (vals[0] >>> 8) & 0xff,
      vals[0] & 0xff,
    ];
  }

  return null;
}

/**
 * Parses an IPv6 address string (including bracketed, compressed '::',
 * IPv4-mapped, IPv4-compatible, and hex forms) into 8 16-bit integer groups.
 * Returns null if not a valid IPv6 string.
 */
export function parseIpv6(ip: string): number[] | null {
  let clean = ip.toLowerCase().trim();
  const zoneIndex = clean.indexOf("%");
  if (zoneIndex !== -1) clean = clean.slice(0, zoneIndex);
  if (clean.startsWith("[") && clean.endsWith("]")) clean = clean.slice(1, -1);

  // Check for embedded dotted-quad IPv4 at the end (e.g. ::ffff:127.0.0.1 or fe80::127.0.0.1)
  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1) {
    const afterLastColon = clean.slice(lastColon + 1);
    if (afterLastColon.includes(".")) {
      const v4Parts = parseIpv4(afterLastColon);
      if (!v4Parts) return null;
      clean =
        clean.slice(0, lastColon) +
        ":" +
        ((v4Parts[0] << 8) | v4Parts[1]).toString(16) +
        ":" +
        ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
    }
  }

  const parts = clean.split("::");
  if (parts.length > 2) return null;

  let groups: number[] = [];
  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(":").map((h) => parseInt(h, 16)) : [];
    const right = parts[1] ? parts[1].split(":").map((h) => parseInt(h, 16)) : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    groups = clean.split(":").map((h) => parseInt(h, 16));
  }

  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

/**
 * Checks if an IPv4 address belongs to a disallowed or private/internal range.
 */
export function isDisallowedIpv4(ip: string): boolean {
  const parts = parseIpv4(ip);
  if (!parts) {
    return true; // malformed IP
  }

  const [b0, b1, b2, b3] = parts;

  // 0.0.0.0/8 Current network
  if (b0 === 0) return true;

  // 127.0.0.0/8 Loopback
  if (b0 === 127) return true;

  // 10.0.0.0/8 Private RFC 1918
  if (b0 === 10) return true;

  // 172.16.0.0/12 Private RFC 1918 (172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.168.0.0/16 Private RFC 1918
  if (b0 === 192 && b1 === 168) return true;

  // 169.254.0.0/16 Link-local / Cloud Metadata (including 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 100.64.0.0/10 Shared Address Space (Carrier NAT)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 192.0.0.0/24 IETF Protocol Assignments
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;

  // 192.0.2.0/24 TEST-NET-1 (RFC 5737)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;

  // 198.18.0.0/15 Benchmarking (198.18.0.0 - 198.19.255.255)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;

  // 198.51.100.0/24 TEST-NET-2 (RFC 5737)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;

  // 203.0.113.0/24 TEST-NET-3 (RFC 5737)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;

  // 224.0.0.0/4 Multicast
  if (b0 >= 224 && b0 <= 239) return true;

  // 240.0.0.0/4 Reserved
  if (b0 >= 240) return true;

  // Broadcast
  if (b0 === 255 && b1 === 255 && b2 === 255 && b3 === 255) return true;

  return false;
}

/**
 * Checks if an IPv6 address belongs to a disallowed internal range.
 */
export function isDisallowedIpv6(ip: string): boolean {
  const groups = parseIpv6(ip);
  if (!groups) {
    return true; // malformed IPv6
  }

  // Unspecified ::/128
  if (groups.every((g) => g === 0)) return true;

  // Loopback ::1/128
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 1
  ) {
    return true;
  }

  // Link-local fe80::/10 (fe80 to febf)
  if ((groups[0] & 0xffc0) === 0xfe80) return true;

  // Unique local fc00::/7 (fc00 to fdff)
  if ((groups[0] & 0xfe00) === 0xfc00) return true;

  // Multicast ff00::/8
  if ((groups[0] & 0xff00) === 0xff00) return true;

  // Discard prefix 0100::/64 (RFC 6666)
  if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true;

  // Documentation prefix 2001:db8::/32 (RFC 3849)
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;

  // IPv4-mapped IPv6 ::ffff:0:0/96 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const b0 = (groups[6] >> 8) & 0xff;
    const b1 = groups[6] & 0xff;
    const b2 = (groups[7] >> 8) & 0xff;
    const b3 = groups[7] & 0xff;
    return isDisallowedIpv4(`${b0}.${b1}.${b2}.${b3}`);
  }

  // IPv4-compatible IPv6 ::/96 (deprecated RFC 4291) (e.g. ::127.0.0.1 or ::7f00:1)
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    !(groups[6] === 0 && groups[7] === 1) // not ::1
  ) {
    const b0 = (groups[6] >> 8) & 0xff;
    const b1 = groups[6] & 0xff;
    const b2 = (groups[7] >> 8) & 0xff;
    const b3 = groups[7] & 0xff;
    return isDisallowedIpv4(`${b0}.${b1}.${b2}.${b3}`);
  }

  // 6to4 prefix 2002::/16 (RFC 3056)
  if (groups[0] === 0x2002) {
    const b0 = (groups[1] >> 8) & 0xff;
    const b1 = groups[1] & 0xff;
    const b2 = (groups[2] >> 8) & 0xff;
    const b3 = groups[2] & 0xff;
    return isDisallowedIpv4(`${b0}.${b1}.${b2}.${b3}`);
  }

  return false;
}

/**
 * Validates a target URL against SSRF threats.
 * Rejects non-HTTP(S) protocols, metadata hostnames, loopbacks, and RFC 1918 IPs.
 */
export async function validateWebhookUrl(
  urlString: string,
  lookupFn: DnsLookupFunction = dns.lookup
): Promise<SsrfCheckResult> {
  if (!urlString || typeof urlString !== "string") {
    return { safe: false, reason: "Empty or invalid URL" };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: "Malformed URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Explicit cloud metadata and internal hostnames
  if (
    hostname === "metadata.google.internal" ||
    hostname === "metadata" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return { safe: false, reason: `Forbidden cloud metadata or internal hostname: ${hostname}` };
  }

  // Strip enclosing brackets for IPv6 literals
  const cleanHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  // If hostname is directly an IPv4 literal (standard, decimal, octal, hex)
  if (net.isIPv4(cleanHost) || parseIpv4(cleanHost) !== null) {
    if (isDisallowedIpv4(cleanHost)) {
      return { safe: false, reason: `Disallowed private or reserved IPv4: ${cleanHost}` };
    }
    return { safe: true, resolvedIp: cleanHost };
  }

  // If hostname is directly an IPv6 literal
  if (net.isIPv6(cleanHost) || parseIpv6(cleanHost) !== null) {
    if (isDisallowedIpv6(cleanHost)) {
      return { safe: false, reason: `Disallowed private or reserved IPv6: ${cleanHost}` };
    }
    return { safe: true, resolvedIp: cleanHost };
  }

  // Resolve hostname via DNS
  try {
    const resolved = await lookupFn(hostname, { all: true });
    if (!resolved || resolved.length === 0) {
      return { safe: false, reason: "DNS resolution yielded no IP addresses" };
    }

    for (const record of resolved) {
      if (record.family === 4 && isDisallowedIpv4(record.address)) {
        return {
          safe: false,
          reason: `Resolved to disallowed IPv4: ${record.address}`,
          resolvedIp: record.address,
        };
      }
      if (record.family === 6 && isDisallowedIpv6(record.address)) {
        return {
          safe: false,
          reason: `Resolved to disallowed IPv6: ${record.address}`,
          resolvedIp: record.address,
        };
      }
    }

    return { safe: true, resolvedIp: resolved[0].address };
  } catch (err: unknown) {
    return {
      safe: false,
      reason: `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
