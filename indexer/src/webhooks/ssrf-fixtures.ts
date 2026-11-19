/**
 * Test fixture set covering modern SSRF bypass vectors:
 * 1. IPv6 loopback, unspecified, and link-local variants
 * 2. IPv4-mapped IPv6 addresses (dotted, hex, uncompressed)
 * 3. Decimal, octal, hex, and shorthand IPv4 encodings
 * 4. DNS hostnames resolving to private/loopback/metadata ranges (simulated resolver)
 * 5. HTTP redirect-based escape attempts to internal targets
 * 6. Public destinations (allowlist behavior must remain safe)
 */

export interface SsrfBypassFixture {
  category:
    | "ipv6-loopback"
    | "ipv6-link-local"
    | "ipv4-mapped-ipv6"
    | "decimal-octal-ip"
    | "dns-private-resolution"
    | "redirect-escape"
    | "public-allowed";
  target: string;
  description: string;
  simulatedDnsRecords?: Array<{ address: string; family: number }>;
  expectedSafe: boolean;
}

export const SSRF_BYPASS_FIXTURES: SsrfBypassFixture[] = [
  // -------------------------------------------------------------
  // 1. IPv6 loopback, unspecified, and link-local variants
  // -------------------------------------------------------------
  {
    category: "ipv6-loopback",
    target: "http://[::1]:9000/hook",
    description: "Standard IPv6 loopback ::1 with port",
    expectedSafe: false,
  },
  {
    category: "ipv6-loopback",
    target: "http://[0:0:0:0:0:0:0:1]:8080/events",
    description: "Uncompressed IPv6 loopback with 8 zero/one groups",
    expectedSafe: false,
  },
  {
    category: "ipv6-loopback",
    target: "http://[0000:0000:0000:0000:0000:0000:0000:0001]/hook",
    description: "Full 32-digit padded IPv6 loopback",
    expectedSafe: false,
  },
  {
    category: "ipv6-loopback",
    target: "http://[::0001]/hook",
    description: "Partially compressed IPv6 loopback with leading zeroes in final group",
    expectedSafe: false,
  },
  {
    category: "ipv6-loopback",
    target: "http://[::]/events",
    description: "IPv6 unspecified address ::",
    expectedSafe: false,
  },
  {
    category: "ipv6-loopback",
    target: "http://[0:0:0:0:0:0:0:0]/events",
    description: "IPv6 unspecified address fully uncompressed",
    expectedSafe: false,
  },
  {
    category: "ipv6-link-local",
    target: "http://[fe80::1]/hook",
    description: "IPv6 link-local address fe80::1",
    expectedSafe: false,
  },
  {
    category: "ipv6-link-local",
    target: "http://[fe80:0:0:0:200:5efe:127.0.0.1]/hook",
    description: "IPv6 link-local with embedded IPv4 loopback",
    expectedSafe: false,
  },
  {
    category: "ipv6-link-local",
    target: "http://[feb0::1]/hook",
    description: "IPv6 link-local upper boundary fe80::/10 (feb0)",
    expectedSafe: false,
  },
  {
    category: "ipv6-link-local",
    target: "http://[fc00::1]/hook",
    description: "IPv6 Unique Local Address fc00::/7 (fc00)",
    expectedSafe: false,
  },
  {
    category: "ipv6-link-local",
    target: "http://[fd00::1]/hook",
    description: "IPv6 Unique Local Address fc00::/7 (fd00)",
    expectedSafe: false,
  },
  {
    category: "ipv6-link-local",
    target: "http://[fd12:3456:789a::1]/hook",
    description: "IPv6 Unique Local Address random ULA prefix",
    expectedSafe: false,
  },
  {
    category: "ipv6-link-local",
    target: "http://[ff02::1]/hook",
    description: "IPv6 all-nodes link-local multicast address",
    expectedSafe: false,
  },

  // -------------------------------------------------------------
  // 2. IPv4-mapped IPv6 (::ffff:127.0.0.1 and hex/full forms)
  // -------------------------------------------------------------
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[::ffff:127.0.0.1]:8080/webhook",
    description: "IPv4-mapped IPv6 loopback dotted-quad",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[::ffff:7f00:1]:8080/webhook",
    description: "IPv4-mapped IPv6 loopback hex segments (WHATWG normalized form)",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[::ffff:10.0.0.1]/webhook",
    description: "IPv4-mapped IPv6 private RFC 1918 10.0.0.1 dotted-quad",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[::ffff:a00:1]/webhook",
    description: "IPv4-mapped IPv6 private 10.0.0.1 in hex notation",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[::ffff:169.254.169.254]/latest/meta-data",
    description: "IPv4-mapped IPv6 AWS/cloud metadata address dotted-quad",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[::ffff:a9fe:a9fe]/computeMetadata/v1/",
    description: "IPv4-mapped IPv6 cloud metadata in hex notation",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[::ffff:192.168.1.1]/webhook",
    description: "IPv4-mapped IPv6 private RFC 1918 192.168.1.1 dotted-quad",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[::ffff:c0a8:101]/webhook",
    description: "IPv4-mapped IPv6 private 192.168.1.1 in hex notation",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[::ffff:172.16.0.1]/webhook",
    description: "IPv4-mapped IPv6 private RFC 1918 172.16.0.1 dotted-quad",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[0:0:0:0:0:ffff:127.0.0.1]/webhook",
    description: "Uncompressed IPv4-mapped IPv6 loopback",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[0000:0000:0000:0000:0000:ffff:7f00:0001]/webhook",
    description: "Fully padded 32-digit IPv4-mapped IPv6 loopback in hex",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[::127.0.0.1]/webhook",
    description: "IPv4-compatible IPv6 (deprecated RFC 4291) loopback",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[2002:7f00:0001::]/webhook",
    description: "6to4 encapsulated loopback 127.0.0.1 (RFC 3056)",
    expectedSafe: false,
  },
  {
    category: "ipv4-mapped-ipv6",
    target: "http://[2002:a9fe:a9fe::]/webhook",
    description: "6to4 encapsulated cloud metadata 169.254.169.254 (RFC 3056)",
    expectedSafe: false,
  },

  // -------------------------------------------------------------
  // 3. Decimal, octal, hex, and shorthand IPv4 encodings
  // -------------------------------------------------------------
  {
    category: "decimal-octal-ip",
    target: "http://2130706433/webhook",
    description: "127.0.0.1 encoded as a 32-bit decimal dword integer",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://0177.0.0.1/webhook",
    description: "127.0.0.1 with octal first octet 0177",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://017700000001/webhook",
    description: "127.0.0.1 encoded as a single octal 32-bit integer",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://0x7f000001/webhook",
    description: "127.0.0.1 encoded as a 32-bit hex dword integer",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://0x7f.0.0.1/webhook",
    description: "127.0.0.1 with hex first octet 0x7f",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://127.1/webhook",
    description: "127.0.0.1 in BSD class A shorthand notation",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://127.0.1/webhook",
    description: "127.0.0.1 in BSD class B shorthand notation",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://0/webhook",
    description: "0.0.0.0 encoded as integer 0 shorthand",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://2852039166/latest/meta-data",
    description: "169.254.169.254 cloud metadata encoded as decimal dword",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://0xa9fea9fe/latest/meta-data",
    description: "169.254.169.254 cloud metadata encoded as hex dword",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://0251.0376.0251.0376/latest/meta-data",
    description: "169.254.169.254 cloud metadata encoded as dotted octal",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://025177524776/latest/meta-data",
    description: "169.254.169.254 cloud metadata encoded as single octal integer",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://167772161/webhook",
    description: "10.0.0.1 private IP encoded as decimal dword",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://012.0.0.1/webhook",
    description: "10.0.0.1 private IP with octal first octet 012",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://0x0a000001/webhook",
    description: "10.0.0.1 private IP encoded as hex dword",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://2886729729/webhook",
    description: "172.16.0.1 private IP encoded as decimal dword",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://3232235521/webhook",
    description: "192.168.0.1 private IP encoded as decimal dword",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://0300.0250.0.1/webhook",
    description: "192.168.0.1 private IP with octal octets",
    expectedSafe: false,
  },
  {
    category: "decimal-octal-ip",
    target: "http://0xc0a80001/webhook",
    description: "192.168.0.1 private IP encoded as hex dword",
    expectedSafe: false,
  },

  // -------------------------------------------------------------
  // 4. DNS names that resolve to private ranges (simulated resolver)
  // -------------------------------------------------------------
  {
    category: "dns-private-resolution",
    target: "http://simulated-loopback.internal-test/webhook",
    description: "Hostname resolving to IPv4 loopback 127.0.0.1",
    simulatedDnsRecords: [{ address: "127.0.0.1", family: 4 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-private-10.internal-test/webhook",
    description: "Hostname resolving to RFC 1918 10.0.0.5",
    simulatedDnsRecords: [{ address: "10.0.0.5", family: 4 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-private-172.internal-test/webhook",
    description: "Hostname resolving to RFC 1918 172.16.50.1",
    simulatedDnsRecords: [{ address: "172.16.50.1", family: 4 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-private-192.internal-test/webhook",
    description: "Hostname resolving to RFC 1918 192.168.1.100",
    simulatedDnsRecords: [{ address: "192.168.1.100", family: 4 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-metadata.internal-test/webhook",
    description: "Hostname resolving to cloud metadata IP 169.254.169.254",
    simulatedDnsRecords: [{ address: "169.254.169.254", family: 4 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-cgnat.internal-test/webhook",
    description: "Hostname resolving to carrier NAT IP 100.64.0.1",
    simulatedDnsRecords: [{ address: "100.64.0.1", family: 4 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-v6-loopback.internal-test/webhook",
    description: "Hostname resolving to IPv6 loopback ::1",
    simulatedDnsRecords: [{ address: "::1", family: 6 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-v6-linklocal.internal-test/webhook",
    description: "Hostname resolving to IPv6 link-local fe80::1",
    simulatedDnsRecords: [{ address: "fe80::1", family: 6 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-v6-ula.internal-test/webhook",
    description: "Hostname resolving to IPv6 unique local fd00::1",
    simulatedDnsRecords: [{ address: "fd00::1", family: 6 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-v6-mapped.internal-test/webhook",
    description: "Hostname resolving to IPv4-mapped IPv6 ::ffff:127.0.0.1",
    simulatedDnsRecords: [{ address: "::ffff:127.0.0.1", family: 6 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-v6-mapped-hex.internal-test/webhook",
    description: "Hostname resolving to IPv4-mapped IPv6 in hex ::ffff:7f00:1",
    simulatedDnsRecords: [{ address: "::ffff:7f00:1", family: 6 }],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-rebind-multihomed.internal-test/webhook",
    description: "Hostname resolving to public IP AND private loopback (DNS rebinding attempt)",
    simulatedDnsRecords: [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    expectedSafe: false,
  },
  {
    category: "dns-private-resolution",
    target: "http://simulated-rebind-v6.internal-test/webhook",
    description: "Hostname resolving to public IPv6 AND IPv6 loopback",
    simulatedDnsRecords: [
      { address: "2607:f8b0:4005:805::200e", family: 6 },
      { address: "::1", family: 6 },
    ],
    expectedSafe: false,
  },

  // -------------------------------------------------------------
  // 5. Public destinations (allowlist preserved)
  // -------------------------------------------------------------
  {
    category: "public-allowed",
    target: "https://example.com/webhook",
    description: "Standard public HTTPS webhook endpoint",
    simulatedDnsRecords: [{ address: "93.184.216.34", family: 4 }],
    expectedSafe: true,
  },
  {
    category: "public-allowed",
    target: "https://93.184.216.34:8443/webhook",
    description: "Direct public IPv4 literal destination",
    expectedSafe: true,
  },
  {
    category: "public-allowed",
    target: "https://[2607:f8b0:4005:805::200e]/webhook",
    description: "Direct public IPv6 literal destination (Google public)",
    expectedSafe: true,
  },
  {
    category: "public-allowed",
    target: "https://api.github.com/events",
    description: "Public domain webhook with dual-stack public DNS records",
    simulatedDnsRecords: [
      { address: "140.82.121.4", family: 4 },
      { address: "2607:f8b0:4005:805::200e", family: 6 },
    ],
    expectedSafe: true,
  },
];

/**
 * Fixtures specifically designed to test redirect-based escapes in WebhookDispatcher.
 * Each specifies the redirect target that a malicious remote server would reply with
 * in its HTTP 3xx Location header.
 */
export const REDIRECT_ESCAPE_FIXTURES = [
  {
    target: "http://127.0.0.1:8080/admin/secrets",
    description: "Redirect to IPv4 loopback endpoint",
  },
  {
    target: "http://169.254.169.254/latest/meta-data/iam/security-credentials",
    description: "Redirect to AWS cloud metadata endpoint",
  },
  {
    target: "http://[::1]:9000/private/keys",
    description: "Redirect to IPv6 loopback",
  },
  {
    target: "http://[fe80::1]/service/internal",
    description: "Redirect to IPv6 link-local",
  },
  {
    target: "http://[::ffff:127.0.0.1]:8080/admin",
    description: "Redirect to IPv4-mapped IPv6 loopback",
  },
  {
    target: "http://2130706433:8080/admin",
    description: "Redirect to decimal encoded loopback",
  },
  {
    target: "http://0177.0.0.1:8080/admin",
    description: "Redirect to octal encoded loopback",
  },
  {
    target: "http://simulated-private-10.internal-test/webhook",
    description: "Redirect to hostname resolving to private RFC 1918 range",
  },
  {
    target: "//127.0.0.1:8080/escaped",
    description: "Protocol-relative redirect to loopback",
  },
  {
    target: "file:///etc/shadow",
    description: "Protocol escape redirect to non-HTTP protocol",
  },
];
