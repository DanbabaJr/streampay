import dns from "node:dns/promises";
import net from "node:net";

export interface SsrfCheckResult {
  safe: boolean;
  reason?: string;
  resolvedIp?: string;
}

/**
 * Checks if an IPv4 address belongs to a disallowed or private/internal range.
 */
function isDisallowedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed IP
  }

  const [b0, b1] = parts;

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
  if (b0 === 192 && b1 === 0 && parts[2] === 0) return true;

  // 198.18.0.0/15 Benchmarking
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;

  // 224.0.0.0/4 Multicast
  if (b0 >= 224 && b0 <= 239) return true;

  // 240.0.0.0/4 Reserved
  if (b0 >= 240) return true;

  // Broadcast
  if (ip === "255.255.255.255") return true;

  return false;
}

/**
 * Checks if an IPv6 address belongs to a disallowed internal range.
 */
function isDisallowedIpv6(ip: string): boolean {
  const norm = ip.toLowerCase();

  // Loopback ::1
  if (norm === "::1" || norm === "0:0:0:0:0:0:0:1") return true;

  // Unspecified ::
  if (norm === "::" || norm === "0:0:0:0:0:0:0:0") return true;

  // Link-local fe80::/10
  if (norm.startsWith("fe8") || norm.startsWith("fe9") || norm.startsWith("fea") || norm.startsWith("feb")) {
    return true;
  }

  // Unique local fc00::/7 (fc00... or fd00...)
  if (norm.startsWith("fc") || norm.startsWith("fd")) {
    return true;
  }

  // IPv4 mapped ::ffff:x.x.x.x
  if (norm.includes("::ffff:")) {
    const ipv4Part = norm.split("::ffff:")[1];
    if (ipv4Part && net.isIPv4(ipv4Part)) {
      return isDisallowedIpv4(ipv4Part);
    }
  }

  return false;
}

/**
 * Validates a target URL against SSRF threats.
 * Rejects non-HTTP(S) protocols, metadata hostnames, loopbacks, and RFC 1918 IPs.
 */
export async function validateWebhookUrl(urlString: string): Promise<SsrfCheckResult> {
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

  // If hostname is directly an IP literal
  if (net.isIPv4(hostname)) {
    if (isDisallowedIpv4(hostname)) {
      return { safe: false, reason: `Disallowed private or reserved IPv4: ${hostname}` };
    }
    return { safe: true, resolvedIp: hostname };
  }

  if (net.isIPv6(hostname)) {
    if (isDisallowedIpv6(hostname)) {
      return { safe: false, reason: `Disallowed private or reserved IPv6: ${hostname}` };
    }
    return { safe: true, resolvedIp: hostname };
  }

  // Resolve hostname via DNS
  try {
    const resolved = await dns.lookup(hostname, { all: true });
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
