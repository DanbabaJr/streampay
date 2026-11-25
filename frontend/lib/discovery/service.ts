import crypto from "node:crypto";
import { Networks } from "@stellar/stellar-sdk";
import type {
  ListingSubmissionPayload,
  ListingWithdrawPayload,
  ListingQueryParams,
  PaginatedListingsResponse,
  PublicListingView,
  InternalListingRecord,
  ListingStatus,
} from "./types.ts";
import {
  computeRateBucket,
  computeDurationBucket,
  computeEquivalenceClass,
  coarsenToUtcDay,
} from "./bucketing.ts";
import {
  verifyPartyConsent,
  verifyPartyWithdrawal,
  generateVerificationAttestation,
} from "./crypto.ts";
import { serializePublicListing } from "./serializer.ts";
import { discoveryStore } from "./store.ts";

async function fallbackReadStream(streamId: string): Promise<StreamInfo> {
  const { readStream } = await import("../stellar.ts");
  return readStream(streamId);
}

export interface StreamInfo {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  startTime: number;
  endTime: number;
  cancelable: boolean;
  status: string;
}

export interface StreamReader {
  (streamId: string): Promise<StreamInfo>;
}

export function getDefaultNetwork(): string {
  return process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

export function getDefaultContractId(): string {
  return process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
}

export function getDefaultKThreshold(): number {
  const envVal = process.env.DISCOVERY_K_ANONYMITY_THRESHOLD;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 3;
}

/**
 * Service orchestrating listing ingestion, verification against contract state,
 * privacy enforcement, and k-anonymity browsing.
 */
export class DiscoveryService {
  private readStreamFn: StreamReader;
  private network: string;
  private contractId: string;
  private kThreshold: number;

  constructor(options?: {
    readStreamFn?: StreamReader;
    network?: string;
    contractId?: string;
    kThreshold?: number;
  }) {
    this.readStreamFn = options?.readStreamFn ?? fallbackReadStream;
    this.network = options?.network ?? getDefaultNetwork();
    this.contractId = options?.contractId ?? getDefaultContractId();
    this.kThreshold = options?.kThreshold ?? getDefaultKThreshold();
  }

  /**
   * Ingest and verify a new listing submission with dual consent signatures.
   */
  public async submitListing(
    submission: ListingSubmissionPayload,
    options?: { nowSeconds?: number }
  ): Promise<{ success: true; listing: PublicListingView } | { success: false; error: string }> {
    const now = options?.nowSeconds ?? Math.floor(Date.now() / 1000);

    // 1. Anti-replay check
    if (discoveryStore.hasNonce(submission.nonce)) {
      return { success: false, error: "REPLAYED_NONCE" };
    }

    // 2. Fetch on-chain stream state
    let stream: StreamInfo;
    try {
      stream = await this.readStreamFn(submission.streamId);
    } catch {
      return { success: false, error: "STREAM_NOT_FOUND_ON_CHAIN" };
    }

    // 3. Status verification: reject cancelled streams
    if (stream.status.toLowerCase() === "cancelled") {
      return { success: false, error: "STREAM_IS_CANCELLED" };
    }

    // 4. Party role matching
    if (submission.senderConsent.address !== stream.sender) {
      return { success: false, error: "WRONG_SENDER" };
    }
    if (submission.recipientConsent.address !== stream.recipient) {
      return { success: false, error: "WRONG_RECIPIENT" };
    }

    // 5. Verify cryptographic signatures
    const senderRes = verifyPartyConsent({
      expectedSigner: stream.sender,
      expectedNetwork: this.network,
      expectedContractId: this.contractId,
      expectedStreamId: submission.streamId,
      nonce: submission.nonce,
      expiry: submission.expiry,
      partyConsent: submission.senderConsent,
      nowSeconds: now,
    });
    if (!senderRes.valid) {
      return { success: false, error: `INVALID_SENDER_SIGNATURE: ${senderRes.error}` };
    }

    const recipientRes = verifyPartyConsent({
      expectedSigner: stream.recipient,
      expectedNetwork: this.network,
      expectedContractId: this.contractId,
      expectedStreamId: submission.streamId,
      nonce: submission.nonce,
      expiry: submission.expiry,
      partyConsent: submission.recipientConsent,
      nowSeconds: now,
    });
    if (!recipientRes.valid) {
      return { success: false, error: `INVALID_RECIPIENT_SIGNATURE: ${recipientRes.error}` };
    }

    // 6. Compute rate and duration buckets directly from contract parameters
    const durationSecs = Math.max(1, stream.endTime - stream.startTime);
    const rateBucket = computeRateBucket(stream.deposit, durationSecs);
    const durationBucket = computeDurationBucket(durationSecs);

    const listingStatus: ListingStatus =
      stream.status.toLowerCase() === "depleted" ? "Completed" : "Active";

    const listingId = crypto.randomUUID();
    const listedDay = coarsenToUtcDay(now);

    const verificationHash = generateVerificationAttestation({
      listingId,
      asset: stream.token,
      rateBucket,
      durationBucket,
      status: listingStatus,
    });

    // 7. Assemble internal record
    const record: InternalListingRecord = {
      listingId,
      streamId: submission.streamId,
      asset: stream.token,
      depositRaw: stream.deposit,
      rateBucket,
      durationBucket,
      status: listingStatus,
      state: "PUBLISHED",
      listedDay,
      createdAt: now,
      sender: stream.sender,
      recipient: stream.recipient,
      senderConsent: submission.senderConsent,
      recipientConsent: submission.recipientConsent,
      nonce: submission.nonce,
      expiry: submission.expiry,
      verificationHash,
    };

    // 8. Store internally
    discoveryStore.saveListing(record);

    // 9. Compute anonymity set size & return serialized public projection
    const active = discoveryStore.getActiveListings();
    const count = active.filter(
      (r) =>
        computeEquivalenceClass(r.asset, r.rateBucket, r.durationBucket) ===
        computeEquivalenceClass(record.asset, record.rateBucket, record.durationBucket)
    ).length;

    const publicView = serializePublicListing(record, count, this.kThreshold);
    return { success: true, listing: publicView };
  }

  /**
   * Process a signed unilateral withdrawal request from either party.
   */
  public withdrawListing(
    withdrawPayload: ListingWithdrawPayload,
    options?: { nowSeconds?: number }
  ): { success: true; listingId: string } | { success: false; error: string } {
    const now = options?.nowSeconds ?? Math.floor(Date.now() / 1000);

    const record = discoveryStore.getListing(withdrawPayload.listingId);
    if (!record || record.state === "WITHDRAWN") {
      return { success: false, error: "LISTING_NOT_FOUND" };
    }

    // Verify stream ID matches record
    if (record.streamId !== withdrawPayload.streamId) {
      return { success: false, error: "MISMATCHED_STREAM_ID" };
    }

    // Signer must be sender or recipient
    const isSender = withdrawPayload.signerAddress === record.sender;
    const isRecipient = withdrawPayload.signerAddress === record.recipient;

    if (!isSender && !isRecipient) {
      return { success: false, error: "UNAUTHORIZED_SIGNER" };
    }

    // Verify withdrawal signature
    const verifyRes = verifyPartyWithdrawal({
      expectedSigner: withdrawPayload.signerAddress,
      expectedNetwork: this.network,
      expectedContractId: this.contractId,
      expectedStreamId: withdrawPayload.streamId,
      listingId: withdrawPayload.listingId,
      nonce: withdrawPayload.nonce,
      timestamp: withdrawPayload.timestamp,
      signature: withdrawPayload.signature,
      nowSeconds: now,
    });

    if (!verifyRes.valid) {
      return { success: false, error: `INVALID_WITHDRAWAL_SIGNATURE: ${verifyRes.error}` };
    }

    // Anti-replay: ensure withdrawal nonce was not already consumed
    if (discoveryStore.hasNonce(withdrawPayload.nonce)) {
      return { success: false, error: "REPLAYED_NONCE" };
    }
    discoveryStore.addNonce(withdrawPayload.nonce);

    // Revoke listing immediately
    discoveryStore.markWithdrawn(withdrawPayload.listingId, now);
    return { success: true, listingId: withdrawPayload.listingId };
  }

  /**
   * Query directory listings with filtering and k-anonymity protection.
   */
  public queryListings(params: ListingQueryParams): PaginatedListingsResponse {
    const allActive = discoveryStore.getActiveListings();

    // 1. Calculate equivalence class counts across all active published streams
    const classCounts = new Map<string, number>();
    for (const r of allActive) {
      const eqKey = computeEquivalenceClass(r.asset, r.rateBucket, r.durationBucket);
      classCounts.set(eqKey, (classCounts.get(eqKey) || 0) + 1);
    }

    // 2. Filter listings based on parameters and k-anonymity
    const filtered = allActive.filter((r) => {
      if (params.asset && r.asset.toLowerCase() !== params.asset.toLowerCase()) {
        return false;
      }
      if (params.rateBucket && r.rateBucket !== params.rateBucket) {
        return false;
      }
      if (params.durationBucket && r.durationBucket !== params.durationBucket) {
        return false;
      }
      if (params.status && r.status !== params.status) {
        return false;
      }

      const eqKey = computeEquivalenceClass(r.asset, r.rateBucket, r.durationBucket);
      const size = classCounts.get(eqKey) || 1;

      // k-anonymity enforcement: suppress low-anonymity unless explicitly opted into
      if (size < this.kThreshold && !params.includeLowAnonymity) {
        return false;
      }

      return true;
    });

    // 3. Pagination
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 20));
    const offset = (page - 1) * limit;
    const paginatedRecords = filtered.slice(offset, offset + limit);

    // 4. Egress serialization
    const listings = paginatedRecords.map((r) => {
      const eqKey = computeEquivalenceClass(r.asset, r.rateBucket, r.durationBucket);
      const size = classCounts.get(eqKey) || 1;
      return serializePublicListing(r, size, this.kThreshold);
    });

    return {
      listings,
      total: filtered.length,
      page,
      limit,
      kThreshold: this.kThreshold,
    };
  }

  /**
   * Retrieve a single listing by ID with verification attestation.
   */
  public getListingById(listingId: string): PublicListingView | null {
    const record = discoveryStore.getListing(listingId);
    if (!record || record.state === "WITHDRAWN") {
      return null;
    }

    const allActive = discoveryStore.getActiveListings();
    const count = allActive.filter(
      (r) =>
        computeEquivalenceClass(r.asset, r.rateBucket, r.durationBucket) ===
        computeEquivalenceClass(record.asset, record.rateBucket, record.durationBucket)
    ).length;

    return serializePublicListing(record, count, this.kThreshold);
  }
}

export const discoveryService = new DiscoveryService();
