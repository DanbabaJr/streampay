/**
 * Testnet-only safety gate for the transaction builder.
 *
 * The builder signs and submits arbitrary contract invocations with the
 * connected wallet, so a misconfigured `PUBLIC` network or a mainnet RPC URL
 * must fail closed before any form is rendered. The UI displays the refusal
 * verbatim; it is intentionally not dismissible.
 */

export type SandboxNetworkLabel = "testnet" | "public";

export interface SandboxSafety {
  safe: boolean;
  reasons: string[];
  rpcHost: string;
}

function rpcHost(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * A host is testnet-only when it is explicitly a testnet endpoint or a local
 * development endpoint. Mainnet hosts, custom hosts of unknown provenance, and
 * malformed URLs are all refused.
 */
function isTestnetHost(host: string): boolean {
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return /(^|[.-])testnet([.-]|$)/.test(host);
}

function isMainnetHost(host: string): boolean {
  if (!host) return false;
  return (
    host === "soroban.stellar.org" ||
    host === "horizon.stellar.org" ||
    /(^|[.-])(mainnet|public)([.-]|$)/.test(host)
  );
}

export function assessSandboxSafety(
  networkLabel: SandboxNetworkLabel,
  rpcUrl: string,
): SandboxSafety {
  const reasons: string[] = [];
  const host = rpcHost(rpcUrl);

  if (networkLabel !== "testnet") {
    reasons.push(
      "This sandbox only submits to Stellar Testnet. NEXT_PUBLIC_NETWORK is set to PUBLIC.",
    );
  }

  if (isMainnetHost(host)) {
    reasons.push(
      `The configured Soroban RPC (${rpcUrl}) points at a mainnet endpoint. Refusing to build or submit transactions.`,
    );
  } else if (!isTestnetHost(host)) {
    reasons.push(
      `The configured Soroban RPC (${rpcUrl || "unset"}) is not an explicit Testnet or local endpoint. Refusing to submit transactions.`,
    );
  }

  return { safe: reasons.length === 0, reasons, rpcHost: host };
}

/** Short label for the sandbox header badge. */
export function sandboxNetworkLabel(): string {
  return "STELLAR TESTNET ONLY";
}
