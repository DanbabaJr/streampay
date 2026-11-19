import type {
  InternalListingRecord,
  PublicListingView,
  AnonymityFlag,
} from "./types.ts";

/**
 * Strict Egress Serializer.
 * Enforces the field allowlist defined in docs/discovery-privacy.md.
 *
 * Guarantees:
 * - On-chain streamId is NEVER included
 * - Exact deposit/balance/withdrawn amounts are NEVER included
 * - Exact start/end timestamps are NEVER included
 * - Signatures, nonces, and secrets are NEVER included
 * - Stellar addresses are ONLY included if BOTH sender and recipient opted in
 */
export function serializePublicListing(
  record: InternalListingRecord,
  anonymitySetSize: number = 1,
  kThreshold: number = 3
): PublicListingView {
  const bothOptedIn =
    Boolean(record.senderConsent?.shareAddress) &&
    Boolean(record.recipientConsent?.shareAddress);

  const anonymityFlag: AnonymityFlag =
    anonymitySetSize >= kThreshold ? "normal" : "low";

  const publicView: PublicListingView = {
    listingId: record.listingId,
    asset: record.asset,
    rateBucket: record.rateBucket,
    durationBucket: record.durationBucket,
    status: record.status,
    listedDay: record.listedDay,
    anonymitySetSize,
    anonymityFlag,
    addressesShared: {
      sender: Boolean(record.senderConsent?.shareAddress),
      recipient: Boolean(record.recipientConsent?.shareAddress),
    },
    verificationHash: record.verificationHash,
  };

  // Addresses are exposed ONLY if BOTH parties opted in
  if (bothOptedIn) {
    publicView.sender = record.sender;
    publicView.recipient = record.recipient;
  }

  return publicView;
}
