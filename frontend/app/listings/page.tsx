"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type {
  PublicListingView,
  RateBucket,
  DurationBucket,
  ListingStatus,
} from "@/lib/discovery/types";
import { fetchDiscoveryListings } from "@/lib/discovery/client";

const RATE_BUCKET_LABELS: Record<RateBucket, string> = {
  RATE_MICRO: "< 10 / day (Micro)",
  RATE_LOW: "10 - 100 / day (Low)",
  RATE_MEDIUM: "100 - 1,000 / day (Medium)",
  RATE_HIGH: "1,000 - 10,000 / day (High)",
  RATE_WHALE: "≥ 10,000 / day (Whale)",
};

const DURATION_BUCKET_LABELS: Record<DurationBucket, string> = {
  DUR_FLASH: "< 1 Day (Flash)",
  DUR_WEEK: "1 - 7 Days",
  DUR_MONTH: "7 - 30 Days",
  DUR_QUARTER: "30 - 90 Days",
  DUR_LONG: "> 90 Days",
};

export default function DiscoveryBrowsePage() {
  const [listings, setListings] = useState<PublicListingView[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [kThreshold, setKThreshold] = useState<number>(3);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  // Filters
  const [assetFilter, setAssetFilter] = useState<string>("");
  const [rateFilter, setRateFilter] = useState<string>("");
  const [durationFilter, setDurationFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [includeLowAnonymity, setIncludeLowAnonymity] = useState<boolean>(false);

  // Verification modal
  const [selectedListing, setSelectedListing] = useState<PublicListingView | null>(null);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  useEffect(() => {
    let ignore = false;

    async function loadData() {
      try {
        const data = await fetchDiscoveryListings({
          asset: assetFilter.trim() || undefined,
          rateBucket: (rateFilter as RateBucket) || undefined,
          durationBucket: (durationFilter as DurationBucket) || undefined,
          status: (statusFilter as ListingStatus) || undefined,
          includeLowAnonymity,
          page,
          limit: 15,
        });
        if (!ignore) {
          setListings(data.listings);
          setTotal(data.total);
          setKThreshold(data.kThreshold);
          setError("");
          setLoading(false);
        }
      } catch (err: unknown) {
        if (!ignore) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setLoading(false);
        }
      }
    }

    void loadData();
    return () => {
      ignore = true;
    };
  }, [assetFilter, rateFilter, durationFilter, statusFilter, includeLowAnonymity, page, refreshKey]);

  const maxPages = Math.max(1, Math.ceil(total / 15));

  return (
    <main className="wrap">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <p className="kicker mono" style={{ margin: "0 0 4px", color: "var(--accent)" }}>
            STREAM DISCOVERY DIRECTORY
          </p>
          <h1>Anonymized Stream Listings</h1>
        </div>
        <Link href="/" style={{ color: "var(--accent2)", fontSize: "14px" }}>
          ← Back to App
        </Link>
      </div>

      <p className="muted" style={{ margin: "4px 0 20px" }}>
        Explore verifiable payment streams published voluntarily by both parties.
        Amounts and durations are coarsened into privacy bands, addresses remain hidden
        unless both parties explicitly opted in, and listings are protected by $k$-anonymity ({kThreshold}+ streams).
      </p>

      {/* Filter Bar */}
      <section className="card" style={{ marginBottom: "20px" }}>
        <div style={{ fontSize: "12px", textTransform: "uppercase", color: "var(--muted)", marginBottom: "10px" }}>
          Filter Listings
        </div>
        <div className="row">
          <div>
            <label htmlFor="filter-asset">Asset</label>
            <input
              id="filter-asset"
              type="text"
              placeholder="Filter by token address..."
              value={assetFilter}
              onChange={(e) => {
                setAssetFilter(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <div>
            <label htmlFor="filter-rate">Flow Rate Band</label>
            <select
              id="filter-rate"
              value={rateFilter}
              onChange={(e) => {
                setRateFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Rates</option>
              {Object.entries(RATE_BUCKET_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-duration">Duration Band</label>
            <select
              id="filter-duration"
              value={durationFilter}
              onChange={(e) => {
                setDurationFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Durations</option>
              {Object.entries(DURATION_BUCKET_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-status">Status</label>
            <select
              id="filter-status"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Completed">Completed</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
          <input
            id="toggle-low-anonymity"
            type="checkbox"
            checked={includeLowAnonymity}
            onChange={(e) => {
              setIncludeLowAnonymity(e.target.checked);
              setPage(1);
            }}
          />
          <label htmlFor="toggle-low-anonymity" style={{ margin: 0, textTransform: "none", cursor: "pointer" }}>
            Show low-anonymity streams (categories with fewer than {kThreshold} active streams)
          </label>
        </div>
      </section>

      {/* Results View */}
      {loading ? (
        <div className="card" style={{ textAlign: "center", padding: "40px" }}>
          <div className="mono" style={{ color: "var(--accent)" }}>Loading verified discovery listings...</div>
        </div>
      ) : error ? (
        <div className="card" style={{ borderColor: "var(--red)" }}>
          <p className="err">{error}</p>
          <button type="button" onClick={() => { setLoading(true); setRefreshKey((k) => k + 1); }}>
            Retry
          </button>
        </div>
      ) : listings.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "40px" }}>
          <h3>No Listings Found</h3>
          <p className="muted">
            {includeLowAnonymity
              ? "No streams match the selected filters."
              : `No streams match the current filters that meet the ${kThreshold}-anonymity threshold. Enable "Show low-anonymity streams" above to inspect rare streams.`}
          </p>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span className="muted" style={{ fontSize: "13px" }}>
              Showing {listings.length} of {total} verified listing(s)
            </span>
            <span className="muted" style={{ fontSize: "13px" }}>
              k-Anonymity threshold: <strong>k ≥ {kThreshold}</strong>
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {listings.map((l) => (
              <div
                key={l.listingId}
                className="card"
                style={{
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  borderColor: l.anonymityFlag === "low" ? "rgba(255, 170, 0, 0.3)" : "var(--line)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "8px" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span className="mono" style={{ fontSize: "12px", color: "var(--muted)" }}>
                        ID: {l.listingId.slice(0, 8)}…
                      </span>
                      <span
                        className={`status-badge ${
                          l.status === "Active" ? "status-active" : "status-completed"
                        }`}
                      >
                        {l.status}
                      </span>
                      {l.anonymityFlag === "low" ? (
                        <span
                          className="status-badge"
                          style={{ background: "#451a03", color: "#fcd34d", border: "1px solid #78350f" }}
                          title="Less than k streams share this exact asset, rate, and duration band"
                        >
                          ⚠️ Low Anonymity ({l.anonymitySetSize})
                        </span>
                      ) : (
                        <span
                          className="status-badge"
                          style={{ background: "#064e3b", color: "#6ee7b7", border: "1px solid #047857" }}
                        >
                          ✓ {l.anonymitySetSize}-Anonymous
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setSelectedListing(l)}
                    style={{
                      margin: 0,
                      padding: "5px 12px",
                      fontSize: "12px",
                      background: "transparent",
                      border: "1px solid var(--accent)",
                      color: "var(--accent)",
                    }}
                  >
                    Verify On-Chain ↗
                  </button>
                </div>

                <div className="row" style={{ marginTop: "4px" }}>
                  <div>
                    <div style={{ fontSize: "11px", textTransform: "uppercase", color: "var(--muted)" }}>Token Asset</div>
                    <div className="mono" style={{ fontSize: "13px", wordBreak: "break-all" }}>
                      {l.asset}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "11px", textTransform: "uppercase", color: "var(--muted)" }}>Flow Rate Band</div>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--accent2)" }}>
                      {RATE_BUCKET_LABELS[l.rateBucket] || l.rateBucket}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "11px", textTransform: "uppercase", color: "var(--muted)" }}>Duration Band</div>
                    <div style={{ fontSize: "13px", fontWeight: 600 }}>
                      {DURATION_BUCKET_LABELS[l.durationBucket] || l.durationBucket}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "11px", textTransform: "uppercase", color: "var(--muted)" }}>Listed Date</div>
                    <div className="mono" style={{ fontSize: "13px" }}>
                      {l.listedDay}
                    </div>
                  </div>
                </div>

                {/* Identity disclosure banner */}
                <div style={{ fontSize: "12px", borderTop: "1px solid var(--line)", paddingTop: "8px", display: "flex", justifyContent: "space-between" }}>
                  {l.sender && l.recipient ? (
                    <span style={{ color: "var(--accent)" }}>
                      Mutual Address Disclosure: Sender <code className="mono">{l.sender.slice(0, 6)}…{l.sender.slice(-4)}</code> → Recipient <code className="mono">{l.recipient.slice(0, 6)}…{l.recipient.slice(-4)}</code>
                    </span>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>
                      🔒 Addresses Private (No identity disclosed by stream parties)
                    </span>
                  )}
                  <span className="mono" style={{ color: "var(--muted)" }}>
                    HMAC: {l.verificationHash.slice(0, 10)}…
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {maxPages > 1 && (
            <div style={{ display: "flex", justifyContent: "center", gap: "12px", marginTop: "24px" }}>
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                style={{ background: "var(--panel)", border: "1px solid var(--line)", color: "var(--text)" }}
              >
                ← Previous
              </button>
              <span style={{ alignSelf: "center", fontSize: "13px" }}>
                Page {page} of {maxPages}
              </span>
              <button
                type="button"
                disabled={page >= maxPages}
                onClick={() => setPage((p) => Math.min(maxPages, p + 1))}
                style={{ background: "var(--panel)", border: "1px solid var(--line)", color: "var(--text)" }}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}

      {/* Verification Deep-Link Modal */}
      {selectedListing && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(10, 14, 22, 0.85)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "16px",
          }}
        >
          <div className="card" style={{ maxWidth: "600px", width: "100%" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: "20px" }}>On-Chain Verification Attestation</h2>
              <button
                onClick={() => setSelectedListing(null)}
                style={{ background: "transparent", color: "var(--muted)", fontSize: "18px", padding: "4px 8px", margin: 0 }}
              >
                ✕
              </button>
            </div>

            <p className="muted" style={{ margin: "12px 0 16px" }}>
              This listing has been verified against on-chain contract state by the StreamPay directory indexer.
              The indexer verified that a real contract stream exists on Stellar with matching rate and duration parameters.
            </p>

            <table style={{ marginBottom: "16px" }}>
              <tbody>
                <tr>
                  <th style={{ width: "160px" }}>Listing UUID</th>
                  <td className="mono">{selectedListing.listingId}</td>
                </tr>
                <tr>
                  <th>Token Asset</th>
                  <td className="mono">{selectedListing.asset}</td>
                </tr>
                <tr>
                  <th>Rate Band</th>
                  <td>{RATE_BUCKET_LABELS[selectedListing.rateBucket]}</td>
                </tr>
                <tr>
                  <th>Duration Band</th>
                  <td>{DURATION_BUCKET_LABELS[selectedListing.durationBucket]}</td>
                </tr>
                <tr>
                  <th>Blind Attestation Hash</th>
                  <td className="mono" style={{ wordBreak: "break-all", color: "var(--accent2)" }}>
                    {selectedListing.verificationHash}
                  </td>
                </tr>
                <tr>
                  <th>Privacy Status</th>
                  <td>
                    {selectedListing.sender && selectedListing.recipient ? (
                      <span style={{ color: "var(--accent)" }}>
                        Both parties mutually disclosed public keys
                      </span>
                    ) : (
                      <span style={{ color: "var(--green)" }}>
                        Zero Address Disclosure (Stream ID & Addresses Protected)
                      </span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>

            {selectedListing.sender && selectedListing.recipient ? (
              <div style={{ marginBottom: "16px", padding: "12px", background: "#0d1320", borderRadius: "8px" }}>
                <div style={{ fontSize: "12px", color: "var(--muted)", marginBottom: "4px" }}>
                  Block Explorer Links (Disclosed by mutual opt-in)
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <a
                    href={`https://stellar.expert/explorer/testnet/account/${selectedListing.sender}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--accent2)", fontSize: "13px" }}
                  >
                    View Sender on Stellar.Expert ↗
                  </a>
                  <a
                    href={`https://stellar.expert/explorer/testnet/account/${selectedListing.recipient}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--accent2)", fontSize: "13px" }}
                  >
                    View Recipient on Stellar.Expert ↗
                  </a>
                </div>
              </div>
            ) : (
              <div
                style={{
                  marginBottom: "16px",
                  padding: "12px",
                  background: "rgba(61, 220, 132, 0.08)",
                  border: "1px solid rgba(61, 220, 132, 0.2)",
                  borderRadius: "8px",
                  fontSize: "13px",
                  color: "var(--text)",
                }}
              >
                🔒 <strong>Privacy Protection Active</strong>: Direct block explorer links are suppressed
                because the stream parties chose not to disclose their Stellar addresses.
                The blind attestation hash proves cryptographic verification without doxxing the stream.
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setSelectedListing(null)}
                style={{ background: "var(--panel)", border: "1px solid var(--line)", color: "var(--text)" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
