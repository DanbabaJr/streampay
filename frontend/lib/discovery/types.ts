/**
 * Schema and types for opt-in anonymized stream discovery listings.
 */

export type RateBucket =
  | "RATE_MICRO"   // < 10 tokens/day
  | "RATE_LOW"     // 10 - 100 tokens/day
  | "RATE_MEDIUM"  // 100 - 1,000 tokens/day
  | "RATE_HIGH"    // 1,000 - 10,000 tokens/day
  | "RATE_WHALE";  // >= 10,000 tokens/day

export type DurationBucket =
  | "DUR_FLASH"    // < 1 day (< 86,400s)
  | "DUR_WEEK"     // 1 - 7 days
  | "DUR_MONTH"    // 7 - 30 days
  | "DUR_QUARTER"  // 30 - 90 days
  | "DUR_LONG";    // > 90 days

export type ListingStatus = "Active" | "Completed";

export type AnonymityFlag = "normal" | "low";

export type ConsentLifecycleState =
  | "PROPOSED"
  | "CONSENTED_BY_ONE"
  | "CONSENTED_BY_BOTH"
  | "PUBLISHED"
  | "WITHDRAWN";

/**
 * Strictly allowlisted public view returned to clients and searchers.
 * No internal fields, raw amounts, or signatures are present.
 */
export interface PublicListingView {
  listingId: string;
  asset: string;
  rateBucket: RateBucket;
  durationBucket: DurationBucket;
  status: ListingStatus;
  listedDay: string; // YYYY-MM-DD
  anonymitySetSize: number;
  anonymityFlag: AnonymityFlag;
  addressesShared: {
    sender: boolean;
    recipient: boolean;
  };
  sender?: string;    // Only present if BOTH parties explicitly opted in
  recipient?: string; // Only present if BOTH parties explicitly opted in
  verificationHash: string; // HMAC blind attestation confirming on-chain validity
}

/**
 * Domain-separated canonical consent message signed by stream parties.
 */
export interface CanonicalConsentMessage {
  action: "STREAM_DISCOVERY_CONSENT";
  version: "1";
  domain: "StreamPayDiscovery:v1";
  network: string;
  contractId: string;
  streamId: string;
  nonce: string;
  expiry: number; // Unix timestamp in seconds
  shareAddress: boolean;
}

/**
 * Domain-separated canonical withdrawal message signed by either stream party.
 */
export interface CanonicalWithdrawMessage {
  action: "STREAM_DISCOVERY_WITHDRAW";
  version: "1";
  domain: "StreamPayDiscovery:v1";
  network: string;
  contractId: string;
  streamId: string;
  listingId: string;
  nonce: string;
  timestamp: number; // Unix timestamp in seconds
}

export interface PartySignature {
  address: string;
  signature: string; // Base64-encoded Ed25519 signature
  shareAddress: boolean;
}

/**
 * Ingestion payload submitted to publish a listing with dual consent.
 */
export interface ListingSubmissionPayload {
  streamId: string;
  nonce: string;
  expiry: number;
  senderConsent: PartySignature;
  recipientConsent: PartySignature;
}

/**
 * Payload submitted to withdraw an existing listing.
 */
export interface ListingWithdrawPayload {
  listingId: string;
  streamId: string;
  nonce: string;
  timestamp: number;
  signerAddress: string;
  signature: string; // Base64-encoded Ed25519 signature
}

/**
 * Internal record stored privately in the directory service.
 * Separated strictly from public views.
 */
export interface InternalListingRecord {
  listingId: string;
  streamId: string;
  asset: string;
  depositRaw: string;
  rateBucket: RateBucket;
  durationBucket: DurationBucket;
  status: ListingStatus;
  state: ConsentLifecycleState;
  listedDay: string; // YYYY-MM-DD
  createdAt: number;
  withdrawnAt?: number;
  sender: string;
  recipient: string;
  senderConsent: PartySignature;
  recipientConsent: PartySignature;
  nonce: string;
  expiry: number;
  verificationHash: string;
}

/**
 * Query filter parameters for browsing directory listings.
 */
export interface ListingQueryParams {
  asset?: string;
  rateBucket?: RateBucket;
  durationBucket?: DurationBucket;
  status?: ListingStatus;
  includeLowAnonymity?: boolean;
  page?: number;
  limit?: number;
}

export interface PaginatedListingsResponse {
  listings: PublicListingView[];
  total: number;
  page: number;
  limit: number;
  kThreshold: number;
}
