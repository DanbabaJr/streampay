import { signMessage } from "@stellar/freighter-api";
import {
  buildCanonicalConsentMessage,
  buildCanonicalWithdrawMessage,
  canonicalJsonStringify,
} from "./crypto.ts";
import type {
  ListingQueryParams,
  PaginatedListingsResponse,
  PublicListingView,
  ListingSubmissionPayload,
  ListingWithdrawPayload,
  PartySignature,
} from "./types.ts";

/**
 * Sign a discovery consent payload using the Freighter wallet.
 */
export async function signConsentWithFreighter(params: {
  signerAddress: string;
  network: string;
  contractId: string;
  streamId: string;
  nonce: string;
  expiry: number;
  shareAddress: boolean;
}): Promise<PartySignature> {
  const canonicalMessage = buildCanonicalConsentMessage({
    network: params.network,
    contractId: params.contractId,
    streamId: params.streamId,
    nonce: params.nonce,
    expiry: params.expiry,
    shareAddress: params.shareAddress,
  });

  const payloadString = canonicalJsonStringify(canonicalMessage);

  const res = await signMessage(payloadString, {
    address: params.signerAddress,
    networkPassphrase: params.network,
  });

  if (res.error || !res.signedMessage) {
    throw new Error(res.error || "Failed to sign consent with Freighter");
  }

  const signatureStr =
    typeof res.signedMessage === "string"
      ? res.signedMessage
      : Buffer.from(res.signedMessage).toString("base64");

  return {
    address: params.signerAddress,
    signature: signatureStr,
    shareAddress: params.shareAddress,
  };
}

/**
 * Sign a unilateral withdrawal payload using the Freighter wallet.
 */
export async function signWithdrawWithFreighter(params: {
  signerAddress: string;
  network: string;
  contractId: string;
  streamId: string;
  listingId: string;
  nonce: string;
  timestamp: number;
}): Promise<ListingWithdrawPayload> {
  const canonicalMessage = buildCanonicalWithdrawMessage({
    network: params.network,
    contractId: params.contractId,
    streamId: params.streamId,
    listingId: params.listingId,
    nonce: params.nonce,
    timestamp: params.timestamp,
  });

  const payloadString = canonicalJsonStringify(canonicalMessage);

  const res = await signMessage(payloadString, {
    address: params.signerAddress,
    networkPassphrase: params.network,
  });

  if (res.error || !res.signedMessage) {
    throw new Error(res.error || "Failed to sign withdrawal with Freighter");
  }

  const signatureStr =
    typeof res.signedMessage === "string"
      ? res.signedMessage
      : Buffer.from(res.signedMessage).toString("base64");

  return {
    listingId: params.listingId,
    streamId: params.streamId,
    nonce: params.nonce,
    timestamp: params.timestamp,
    signerAddress: params.signerAddress,
    signature: signatureStr,
  };
}

/**
 * Client helper to browse discovery listings from API.
 */
export async function fetchDiscoveryListings(
  params: ListingQueryParams
): Promise<PaginatedListingsResponse> {
  const query = new URLSearchParams();
  if (params.asset) query.set("asset", params.asset);
  if (params.rateBucket) query.set("rateBucket", params.rateBucket);
  if (params.durationBucket) query.set("durationBucket", params.durationBucket);
  if (params.status) query.set("status", params.status);
  if (params.includeLowAnonymity) query.set("includeLowAnonymity", "true");
  if (params.page) query.set("page", String(params.page));
  if (params.limit) query.set("limit", String(params.limit));

  const res = await fetch(`/api/listings?${query.toString()}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP error ${res.status}`);
  }
  return res.json();
}

/**
 * Client helper to submit a completed dual-consent listing.
 */
export async function submitDiscoveryListing(
  payload: ListingSubmissionPayload
): Promise<PublicListingView> {
  const res = await fetch("/api/listings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Submission failed with status ${res.status}`);
  }

  return res.json();
}

/**
 * Client helper to withdraw an active listing.
 */
export async function withdrawDiscoveryListing(
  payload: ListingWithdrawPayload
): Promise<void> {
  const res = await fetch(`/api/listings/${payload.listingId}/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Withdrawal failed with status ${res.status}`);
  }
}
