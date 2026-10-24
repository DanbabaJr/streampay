import type { InternalListingRecord, ConsentLifecycleState } from "./types.ts";

/**
 * Interface for private consent proof storage.
 * Completely segregated from public index queries.
 */
export interface PrivateConsentProof {
  listingId: string;
  streamId: string;
  depositRaw: string;
  sender: string;
  recipient: string;
  senderConsent: {
    address: string;
    signature: string;
    shareAddress: boolean;
  };
  recipientConsent: {
    address: string;
    signature: string;
    shareAddress: boolean;
  };
  nonce: string;
  expiry: number;
}

export interface PendingProposal {
  streamId: string;
  nonce: string;
  expiry: number;
  initiatorConsent: {
    address: string;
    signature: string;
    shareAddress: boolean;
  };
}

/**
 * Interface contract for Discovery Storage.
 * Implementations can be in-memory (prototype) or backed by the StreamPay indexer store.
 */
export interface IDiscoveryStore {
  saveListing(record: InternalListingRecord): void;
  getListing(listingId: string): InternalListingRecord | undefined;
  getProof(listingId: string): PrivateConsentProof | undefined;
  getActiveListings(): InternalListingRecord[];
  markWithdrawn(listingId: string, timestamp: number): boolean;
  hasNonce(nonce: string): boolean;
  addNonce(nonce: string): void;
  saveProposal(proposalId: string, proposal: PendingProposal): void;
  getProposal(proposalId: string): PendingProposal | undefined;
  clear(): void;
}

/**
 * ARCHITECTURAL NOTICE — PROTOTYPE-GRADE IN-MEMORY DURABILITY:
 * -------------------------------------------------------------
 * This default implementation stores directory records, proposals, nonces, and
 * private consent proofs in process memory via Node's `globalThis`.
 *
 * Operational Caveats:
 * 1. Serverless Environments (Netlify Functions, Vercel, AWS Lambda):
 *    Process state is ephemeral. Cold starts, container recycling, or worker terminations
 *    reset in-memory records. Listings created on one instance are invisible to sibling
 *    instances unless persisted.
 * 2. Multi-Instance Deployments:
 *    Independent server instances maintain isolated Map instances, fragmenting directory
 *    queries and rate limits.
 * 3. Consent Audit Durability:
 *    Consent records that die with the process undermine the durable consent story.
 * 4. Nonce Replay Defense Durability:
 *    Nonce replay protection is only as durable as the in-memory store — the `usedNonces` set dies
 *    with the process and does not sync across serverless instances, so nobody should read this
 *    replay defense as production-grade.
 *
 * All discovery HTTP endpoints emit an `X-Discovery-Durability: prototype-in-memory` header
 * alongside this notice: nonce replay protection is only as durable as the in-memory store.
 *
 * Production Migration Path:
 * - Back this `IDiscoveryStore` interface with the StreamPay indexer SQLite/Postgres store
 *   (see `indexer/src/store.ts` and `indexer/db/schema.sql` for `discovery_listings`,
 *   `discovery_consent_vault`, and `discovery_nonces` tables).
 * - Maintain strict physical and authorization separation between the public listings index
 *   and the private consent vault.
 */
class DiscoveryStore implements IDiscoveryStore {
  // Public index table: contains only aggregated metadata and lifecycle state
  private publicRecords = new Map<string, InternalListingRecord>();

  // Private proof vault: contains on-chain stream IDs, raw stroop amounts, and cryptographic signatures
  private privateProofVault = new Map<string, PrivateConsentProof>();

  // Replay prevention: set of used nonces
  private usedNonces = new Set<string>();

  // Optional proposals waiting for second signature
  private pendingProposals = new Map<string, {
    streamId: string;
    nonce: string;
    expiry: number;
    initiatorConsent: {
      address: string;
      signature: string;
      shareAddress: boolean;
    };
  }>();

  public saveListing(record: InternalListingRecord): void {
    // 1. Store private proof in secure vault
    const proof: PrivateConsentProof = {
      listingId: record.listingId,
      streamId: record.streamId,
      depositRaw: record.depositRaw,
      sender: record.sender,
      recipient: record.recipient,
      senderConsent: record.senderConsent,
      recipientConsent: record.recipientConsent,
      nonce: record.nonce,
      expiry: record.expiry,
    };
    this.privateProofVault.set(record.listingId, proof);

    // 2. Mark nonce as consumed
    this.usedNonces.add(record.nonce);

    // 3. Store active public record
    this.publicRecords.set(record.listingId, { ...record });
  }

  public getListing(listingId: string): InternalListingRecord | undefined {
    return this.publicRecords.get(listingId);
  }

  public getProof(listingId: string): PrivateConsentProof | undefined {
    return this.privateProofVault.get(listingId);
  }

  public getActiveListings(): InternalListingRecord[] {
    return Array.from(this.publicRecords.values()).filter(
      (r) => r.state === "PUBLISHED"
    );
  }

  public markWithdrawn(listingId: string, timestamp: number): boolean {
    const record = this.publicRecords.get(listingId);
    if (!record) return false;

    record.state = "WITHDRAWN" as ConsentLifecycleState;
    record.withdrawnAt = timestamp;
    this.publicRecords.set(listingId, record);
    return true;
  }

  public hasNonce(nonce: string): boolean {
    return this.usedNonces.has(nonce);
  }

  public addNonce(nonce: string): void {
    this.usedNonces.add(nonce);
  }

  public saveProposal(proposalId: string, proposal: {
    streamId: string;
    nonce: string;
    expiry: number;
    initiatorConsent: {
      address: string;
      signature: string;
      shareAddress: boolean;
    };
  }): void {
    this.pendingProposals.set(proposalId, proposal);
  }

  public getProposal(proposalId: string) {
    return this.pendingProposals.get(proposalId);
  }

  public clear(): void {
    this.publicRecords.clear();
    this.privateProofVault.clear();
    this.usedNonces.clear();
    this.pendingProposals.clear();
  }
}

// Global singleton to preserve directory state across Next.js API requests
const globalStore = globalThis as unknown as {
  __streampay_discovery_store__?: DiscoveryStore;
};

if (!globalStore.__streampay_discovery_store__) {
  globalStore.__streampay_discovery_store__ = new DiscoveryStore();
}

export const discoveryStore = globalStore.__streampay_discovery_store__;
