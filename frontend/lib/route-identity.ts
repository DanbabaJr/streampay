/**
 * Route identifier validation and resolution.
 *
 * The dynamic routes under app/ carry a user-controlled identifier in the URL:
 * a stream id, a Stellar address, or a payment-link reference. The pages use
 * these helpers to separate two outcomes that must not be conflated:
 *
 *   - malformed: the identifier cannot name anything (400-style message), and
 *   - missing:   the identifier is well formed but no entity exists (404).
 *
 * Loaders are injected so the decision is testable without an RPC node and so
 * transport failures are never mistaken for a missing entity: a loader that
 * throws propagates, only a loader that resolves to `null` means "absent".
 */

import { StrKey } from "@stellar/stellar-sdk";

const U64_MAX = (1n << 64n) - 1n;

/** Stream ids are unsigned 64-bit integers rendered as decimal strings. */
export function isStreamId(value: string): boolean {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  try {
    const id = BigInt(value);
    return id >= 0n && id <= U64_MAX;
  } catch {
    return false;
  }
}

/**
 * A Stellar account address: 56 characters, starting with G, with a valid
 * StrKey checksum. The checksum matters — a typo that preserves length and
 * alphabet still cannot name an account.
 */
export function isStellarAddress(value: string): boolean {
  if (typeof value !== "string" || value.length !== 56 || !value.startsWith("G")) {
    return false;
  }
  try {
    return StrKey.isValidEd25519PublicKey(value);
  } catch {
    return false;
  }
}

export type RouteResolution<T> =
  | { status: "malformed" }
  | { status: "missing" }
  | { status: "ok"; value: T };

/** Resolve a stream id, distinguishing a bad id from an absent stream. */
export async function resolveStream<T>(
  id: string,
  load: (id: string) => Promise<T | null>
): Promise<RouteResolution<T>> {
  if (!isStreamId(id)) return { status: "malformed" };
  const value = await load(id);
  return value === null ? { status: "missing" } : { status: "ok", value };
}

/**
 * Resolve an address route. Shape validation is all this route can decide
 * locally; the caller still checks whether the account has any streams.
 */
export function resolveAddress(address: string): RouteResolution<string> {
  return isStellarAddress(address)
    ? { status: "ok", value: address }
    : { status: "malformed" };
}

/**
 * Resolve a payment-link reference. `decode` returns `null` when the reference
 * is not a valid, checksum-clean payload; `load` returns `null` when the
 * referenced stream no longer exists. The 404 path deliberately does not say
 * whether the reference was once valid (docs/discovery-privacy.md).
 */
export async function resolvePaymentRef<D, T>(
  ref: string,
  decode: (ref: string) => Promise<D | null>,
  load: (decoded: D) => Promise<T | null>
): Promise<RouteResolution<T>> {
  const decoded = await decode(ref);
  if (decoded === null) return { status: "malformed" };
  const value = await load(decoded);
  return value === null ? { status: "missing" } : { status: "ok", value };
}
