"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { StreamView, StreamRoleFilter, StreamStatusFilter } from "@/lib/stellar";
import { computeAccruedAt, computeAvailable } from "@/lib/accrual";

export interface AddressStats {
  totalStreams: number;
  activeStreams: number;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
}

export interface AddressExplorerClientProps {
  address: string;
  streams: StreamView[];
  asOfTimestamp: number;
  tab: StreamRoleFilter;
  status: StreamStatusFilter;
  nextCursor: string | null;
  prevCursor: string | null;
  hasMore: boolean;
  hasPrev: boolean;
  totalMatching: number;
  stats: AddressStats;
}

function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

function formatDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAmount(v: bigint | string): string {
  const val = typeof v === "string" ? BigInt(v) : v;
  return val.toLocaleString();
}

export default function AddressExplorerClient({
  address,
  streams,
  asOfTimestamp,
  tab,
  status,
  nextCursor,
  prevCursor,
  hasMore,
  hasPrev,
  totalMatching,
  stats,
}: AddressExplorerClientProps) {
  // Reconcile SSR snapshot timestamp with client-side 1-second interval tick
  const [tickNow, setTickNow] = useState<number>(asOfTimestamp);
  const [copied, setCopied] = useState(false);

  // -------------------------------------------------------------------------
  // Live-region throttle: announce accrual updates to screen readers at most
  // once every 5 seconds across the whole page (WCAG 4.1.3, live-region spec).
  // A single polite region covers all per-card counters; over-announcing a
  // per-second ticker is distracting and was identified in the a11y audit.
  // -------------------------------------------------------------------------
  const liveRegionRef = useRef<HTMLSpanElement | null>(null);
  const lastAnnounceTimeRef = useRef<number>(0);
  const ANNOUNCE_THROTTLE_MS = 5_000;

  // IDs for static ARIA label associations
  const statsRegionId = useId();
  const listingsSectionId = useId();
  const copyStatusId = useId();

  useEffect(() => {
    const timer = setInterval(() => {
      setTickNow(Math.floor(Date.now() / 1000));

      // Throttled screen-reader announcement for the live accrual
      if (
        liveRegionRef.current &&
        Date.now() - lastAnnounceTimeRef.current >= ANNOUNCE_THROTTLE_MS
      ) {
        lastAnnounceTimeRef.current = Date.now();
        const activeCount = streams.filter((s) => s.status === "Active").length;
        if (activeCount > 0) {
          // Clear then set so AT picks up repeated updates
          liveRegionRef.current.textContent = "";
          requestAnimationFrame(() => {
            if (liveRegionRef.current) {
              liveRegionRef.current.textContent =
                `Accrual updated. ${activeCount} active stream${activeCount === 1 ? "" : "s"} ticking.`;
            }
          });
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [streams]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures silently; the visible label is enough
    }
  }

  function makeUrl(overrides: {
    tab?: string;
    status?: string;
    cursor?: string | null;
    dir?: string;
  }): string {
    const params = new URLSearchParams();
    const targetTab = overrides.tab !== undefined ? overrides.tab : tab;
    const targetStatus = overrides.status !== undefined ? overrides.status : status;

    if (targetTab && targetTab !== "all") params.set("tab", targetTab);
    if (targetStatus && targetStatus !== "all") params.set("status", targetStatus);

    if (overrides.cursor) {
      params.set("cursor", overrides.cursor);
      if (overrides.dir) params.set("dir", overrides.dir);
    }

    const qs = params.toString();
    return `/address/${address}${qs ? `?${qs}` : ""}`;
  }

  return (
    <main className="wrap">
      {/* Polite live region for throttled accrual announcements */}
      <span
        ref={liveRegionRef}
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      />

      <div style={{ marginBottom: 16 }}>
        <Link href="/" style={{ fontSize: 13, color: "var(--muted)" }}>
          ← Back to StreamPay
        </Link>
      </div>

      <header style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1 style={{ margin: "0 0 4px 0", fontSize: 26 }}>Address Explorer</h1>
              {/* aria-hidden on the dot; the text "Live" carries the meaning */}
              <span
                className="live-indicator"
                aria-label="Live accrual — updates every second"
              >
                <span className="live-dot" aria-hidden="true" />
                Live
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              <span
                className="mono"
                style={{ fontSize: 14, color: "var(--text)", wordBreak: "break-all" }}
              >
                {address}
              </span>
              <button
                type="button"
                className="copy-btn"
                onClick={copyAddress}
                aria-label={copied ? "Address copied" : "Copy address to clipboard"}
                aria-pressed={copied}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
              {/* Polite copy-status for AT — redundant visually but correct for SR */}
              <span
                id={copyStatusId}
                className="sr-only"
                aria-live="polite"
                aria-atomic="true"
              >
                {copied ? "Address copied to clipboard." : ""}
              </span>
            </div>
          </div>

          <div style={{ textAlign: "right" }}>
            <span className="muted" style={{ fontSize: 12 }}>
              Snapshot as of {new Date(asOfTimestamp * 1000).toLocaleTimeString()}
            </span>
          </div>
        </div>
      </header>

      {/* Aggregate Stats Bar — WCAG 1.3.1: region landmark with label */}
      <section
        id={statsRegionId}
        className="stats-grid"
        aria-label="Address stream aggregates"
      >
        <div className="stat-box">
          <span className="stat-label" id={`${statsRegionId}-total`}>
            Total Streams
          </span>
          <span
            className="stat-value"
            aria-labelledby={`${statsRegionId}-total`}
          >
            {stats.totalStreams}
          </span>
        </div>
        <div className="stat-box">
          <span className="stat-label" id={`${statsRegionId}-active`}>
            Active Streams
          </span>
          <span
            className="stat-value"
            style={{ color: "var(--green)" }}
            aria-labelledby={`${statsRegionId}-active`}
          >
            {stats.activeStreams}
          </span>
        </div>
        <div className="stat-box">
          <span className="stat-label" id={`${statsRegionId}-deposited`}>
            Total Deposited
          </span>
          <span
            className="stat-value"
            aria-labelledby={`${statsRegionId}-deposited`}
          >
            {formatAmount(stats.totalDeposited)}
          </span>
        </div>
        <div className="stat-box">
          <span className="stat-label" id={`${statsRegionId}-claimed`}>
            Total Claimed
          </span>
          <span
            className="stat-value"
            style={{ color: "var(--accent2)" }}
            aria-labelledby={`${statsRegionId}-claimed`}
          >
            {formatAmount(stats.totalWithdrawn)}
          </span>
        </div>
      </section>

      {/* Navigation & Filter Controls */}
      <nav className="filter-controls" aria-label="Filter streams">
        {/* Direction filter — tab role pattern */}
        <div
          className="filter-group"
          role="tablist"
          aria-label="Direction filter"
        >
          <Link
            href={makeUrl({ tab: "all", cursor: null })}
            className={`filter-btn ${tab === "all" ? "active" : ""}`}
            role="tab"
            aria-selected={tab === "all"}
          >
            All Streams
          </Link>
          <Link
            href={makeUrl({ tab: "incoming", cursor: null })}
            className={`filter-btn ${tab === "incoming" ? "active" : ""}`}
            role="tab"
            aria-selected={tab === "incoming"}
          >
            Incoming (Recipient)
          </Link>
          <Link
            href={makeUrl({ tab: "outgoing", cursor: null })}
            className={`filter-btn ${tab === "outgoing" ? "active" : ""}`}
            role="tab"
            aria-selected={tab === "outgoing"}
          >
            Outgoing (Sender)
          </Link>
        </div>

        {/* Status filter — toolbar/group pattern; not tablist (different axis) */}
        <div
          className="filter-group"
          role="group"
          aria-label="Status filter"
        >
          <Link
            href={makeUrl({ status: "all", cursor: null })}
            className={`filter-btn ${status === "all" ? "active" : ""}`}
            aria-current={status === "all" ? "true" : undefined}
          >
            All Status
          </Link>
          <Link
            href={makeUrl({ status: "active", cursor: null })}
            className={`filter-btn ${status === "active" ? "active" : ""}`}
            aria-current={status === "active" ? "true" : undefined}
          >
            Active Only
          </Link>
          <Link
            href={makeUrl({ status: "ended", cursor: null })}
            className={`filter-btn ${status === "ended" ? "active" : ""}`}
            aria-current={status === "ended" ? "true" : undefined}
          >
            Ended
          </Link>
        </div>
      </nav>

      {/* Matching count — polite status summary for SR */}
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 16px" }}
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="muted" style={{ fontSize: 13 }}>
          Showing {streams.length} of {totalMatching} matching stream{totalMatching === 1 ? "" : "s"}
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          Sorted by Stream ID (Monotonic append-only index)
        </span>
      </div>

      {/* Streams list */}
      {streams.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 20px" }}>
          <p style={{ fontSize: 16, margin: "0 0 12px 0", color: "var(--text)" }}>
            No streams found for this address.
          </p>
          <p className="muted" style={{ margin: "0 0 20px 0" }}>
            {status !== "all" || tab !== "all"
              ? "Try adjusting the filters above to view other stream directions or statuses."
              : "This address has not yet created or received streaming payments on StreamPay."}
          </p>
          <Link href="/" className="page-btn" style={{ display: "inline-block" }}>
            Create a Stream
          </Link>
        </div>
      ) : (
        <section id={listingsSectionId} aria-label="Stream listings">
          {streams.map((s) => {
            const deposit = BigInt(s.deposit);
            const withdrawn = BigInt(s.withdrawn);
            const availableNow = computeAvailable(
              deposit,
              s.startTime,
              s.endTime,
              withdrawn,
              s.status,
              BigInt(tickNow)
            );
            const accruedNow = computeAccruedAt(
              deposit,
              s.startTime,
              s.endTime,
              BigInt(tickNow)
            );

            const isRecipient = address === s.recipient;
            const counterparty = isRecipient ? s.sender : s.recipient;
            const counterpartyRole = isRecipient ? "Sender" : "Recipient";

            const progressPct =
              deposit > 0n
                ? Math.min(100, Number((accruedNow * 100n) / deposit))
                : 0;

            const withdrawnPct =
              deposit > 0n
                ? Math.min(100, Number((withdrawn * 100n) / deposit))
                : 0;

            const statusClass =
              s.status === "Active"
                ? "status-active"
                : s.status === "Cancelled"
                ? "status-cancelled"
                : "status-depleted";

            // Stable IDs for aria-labelledby within this card
            const cardTitleId = `stream-card-title-${s.id}`;
            const availLabelId = `avail-label-${s.id}`;
            const depositLabelId = `deposit-label-${s.id}`;
            const claimedLabelId = `claimed-label-${s.id}`;
            const windowLabelId = `window-label-${s.id}`;

            return (
              <article
                key={s.id}
                className="stream-card"
                aria-labelledby={cardTitleId}
              >
                <div className="stream-card-header">
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <Link
                      id={cardTitleId}
                      href={`/stream/${s.id}`}
                      className="mono"
                      style={{ fontSize: 16, fontWeight: 700, color: "var(--accent2)" }}
                    >
                      Stream #{s.id}
                    </Link>
                    {/* Status badges use both colour AND text — WCAG 1.4.1 */}
                    <span className={`status-badge ${statusClass}`}>
                      {s.status}
                    </span>
                    <span
                      className="badge-pill"
                      style={{
                        background: isRecipient ? "rgba(61,220,132,0.12)" : "rgba(139,124,255,0.12)",
                        color: isRecipient ? "var(--green)" : "var(--accent)",
                      }}
                    >
                      {isRecipient ? "Incoming" : "Outgoing"}
                    </span>
                    {s.cancelable ? (
                      <span
                        className="badge-pill"
                        style={{ background: "rgba(255,255,255,0.06)", color: "var(--muted)" }}
                      >
                        Cancelable
                      </span>
                    ) : null}
                  </div>

                  <div style={{ fontSize: 13 }}>
                    <span className="muted">{counterpartyRole}: </span>
                    <Link
                      href={`/address/${counterparty}`}
                      className="mono"
                      title={counterparty}
                      style={{ color: "var(--text)" }}
                    >
                      {truncateAddress(counterparty)}
                    </Link>
                  </div>
                </div>

                {/* Progress bar — role=progressbar with all required attributes */}
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPct}
                  aria-label={`Stream #${s.id} accrual progress: ${progressPct}% accrued, ${withdrawnPct}% claimed`}
                  className="progress-track"
                >
                  <div
                    className="progress-fill"
                    style={{ width: `${progressPct}%` }}
                    aria-hidden="true"
                  />
                </div>

                {/* Live Numbers Grid */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                    gap: 12,
                    margin: "12px 0",
                    fontSize: 13,
                  }}
                >
                  <div>
                    <div
                      className="muted"
                      style={{ fontSize: 11, textTransform: "uppercase" }}
                      id={availLabelId}
                    >
                      Available Now
                    </div>
                    {/* Visible value updated every second. Screen-reader
                        announcements come from the page-level live region
                        (throttled 5 s) — not from this element directly,
                        to avoid overwhelming AT with per-second updates. */}
                    <div
                      className="mono"
                      aria-labelledby={availLabelId}
                      data-asof={asOfTimestamp}
                      style={{
                        fontSize: 16,
                        fontWeight: 700,
                        color: availableNow > 0n ? "var(--green)" : "var(--text)",
                      }}
                    >
                      {formatAmount(availableNow)}
                    </div>
                  </div>

                  <div>
                    <div
                      className="muted"
                      style={{ fontSize: 11, textTransform: "uppercase" }}
                      id={depositLabelId}
                    >
                      Total Deposit
                    </div>
                    <div
                      className="mono"
                      aria-labelledby={depositLabelId}
                      style={{ fontSize: 14 }}
                    >
                      {formatAmount(deposit)}
                    </div>
                  </div>

                  <div>
                    <div
                      className="muted"
                      style={{ fontSize: 11, textTransform: "uppercase" }}
                      id={claimedLabelId}
                    >
                      Claimed / Withdrawn
                    </div>
                    <div
                      className="mono"
                      aria-labelledby={claimedLabelId}
                      style={{ fontSize: 14, color: "var(--muted)" }}
                    >
                      {formatAmount(withdrawn)}
                    </div>
                  </div>

                  <div>
                    <div
                      className="muted"
                      style={{ fontSize: 11, textTransform: "uppercase" }}
                      id={windowLabelId}
                    >
                      Window
                    </div>
                    <div
                      style={{ fontSize: 12, color: "var(--muted)" }}
                      aria-labelledby={windowLabelId}
                    >
                      {formatDate(s.startTime)} → {formatDate(s.endTime)}
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: "1px solid var(--line)",
                  }}
                >
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    Token: {truncateAddress(s.token)}
                  </span>
                  <Link
                    href={`/stream/${s.id}`}
                    style={{ fontSize: 12, color: "var(--accent)" }}
                  >
                    Inspect stream →
                  </Link>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* Cursor Pagination Bar */}
      <nav className="pagination-bar" aria-label="Pagination navigation">
        <Link
          href={makeUrl({ cursor: prevCursor, dir: "backward" })}
          className={`page-btn ${hasPrev ? "" : "disabled"}`}
          aria-disabled={!hasPrev}
          tabIndex={hasPrev ? 0 : -1}
        >
          ← Newer (Previous)
        </Link>

        <div style={{ textAlign: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Monotonic Cursor Pagination
          </span>
        </div>

        <Link
          href={makeUrl({ cursor: nextCursor, dir: "forward" })}
          className={`page-btn ${hasMore ? "" : "disabled"}`}
          aria-disabled={!hasMore}
          tabIndex={hasMore ? 0 : -1}
        >
          Older (Next) →
        </Link>
      </nav>

      {/* Stability note */}
      <aside
        style={{
          background: "rgba(139, 124, 255, 0.05)",
          border: "1px solid rgba(139, 124, 255, 0.2)",
          borderRadius: 8,
          padding: "12px 16px",
          fontSize: 12,
          color: "var(--muted)",
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: "var(--text)" }}>Stability Guarantee: </strong>
        StreamPay stream IDs are strictly monotonic and append-only. Cursor
        pagination partitions on immutable stream ID bounds rather than volatile
        record offsets, completely eliminating page-shift glitches and duplicated
        entries when streams are concurrently cancelled or completed.
      </aside>
    </main>
  );
}
