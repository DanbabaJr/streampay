"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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

  useEffect(() => {
    const timer = setInterval(() => {
      setTickNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures
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
              <span className="live-indicator">
                <span className="live-dot" />
                Live Accrual Tick
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              <span className="mono" style={{ fontSize: 14, color: "var(--text)", wordBreak: "break-all" }}>
                {address}
              </span>
              <button
                type="button"
                className="copy-btn"
                onClick={copyAddress}
                title="Copy full address"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          <div style={{ textAlign: "right" }}>
            <span className="muted" style={{ fontSize: 12 }}>
              Snapshot as of {new Date(asOfTimestamp * 1000).toLocaleTimeString()}
            </span>
          </div>
        </div>
      </header>

      {/* Aggregate Stats Bar */}
      <section className="stats-grid" aria-label="Address stream aggregates">
        <div className="stat-box">
          <span className="stat-label">Total Streams</span>
          <span className="stat-value">{stats.totalStreams}</span>
        </div>
        <div className="stat-box">
          <span className="stat-label">Active Streams</span>
          <span className="stat-value" style={{ color: "var(--green)" }}>{stats.activeStreams}</span>
        </div>
        <div className="stat-box">
          <span className="stat-label">Total Deposited</span>
          <span className="stat-value">{formatAmount(stats.totalDeposited)}</span>
        </div>
        <div className="stat-box">
          <span className="stat-label">Total Claimed</span>
          <span className="stat-value" style={{ color: "var(--accent2)" }}>{formatAmount(stats.totalWithdrawn)}</span>
        </div>
      </section>

      {/* Navigation & Filter Controls */}
      <nav className="filter-controls" aria-label="Filter streams">
        <div className="filter-group" role="tablist" aria-label="Direction filter">
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

        <div className="filter-group" aria-label="Status filter">
          <Link
            href={makeUrl({ status: "all", cursor: null })}
            className={`filter-btn ${status === "all" ? "active" : ""}`}
          >
            All Status
          </Link>
          <Link
            href={makeUrl({ status: "active", cursor: null })}
            className={`filter-btn ${status === "active" ? "active" : ""}`}
          >
            Active Only
          </Link>
          <Link
            href={makeUrl({ status: "ended", cursor: null })}
            className={`filter-btn ${status === "ended" ? "active" : ""}`}
          >
            Ended
          </Link>
        </div>
      </nav>

      {/* Matching count summary */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 16px" }}>
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
        <section aria-label="Stream listings">
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

            return (
              <article key={s.id} className="stream-card">
                <div className="stream-card-header">
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <Link
                      href={`/stream/${s.id}`}
                      className="mono"
                      style={{ fontSize: 16, fontWeight: 700, color: "var(--accent2)" }}
                    >
                      Stream #{s.id}
                    </Link>
                    <span className={`status-badge ${statusClass}`}>
                      {s.status}
                    </span>
                    <span className="badge-pill" style={{ background: isRecipient ? "rgba(61,220,132,0.12)" : "rgba(139,124,255,0.12)", color: isRecipient ? "var(--green)" : "var(--accent)" }}>
                      {isRecipient ? "Incoming" : "Outgoing"}
                    </span>
                    {s.cancelable ? (
                      <span className="badge-pill" style={{ background: "rgba(255,255,255,0.06)", color: "var(--muted)" }}>
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

                {/* Progress bar */}
                <div className="progress-track" title={`${progressPct}% accrued, ${withdrawnPct}% claimed`}>
                  <div
                    className="progress-fill"
                    style={{ width: `${progressPct}%` }}
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
                    <div className="muted" style={{ fontSize: 11, textTransform: "uppercase" }}>Available Now</div>
                    <div
                      className="mono"
                      data-asof={asOfTimestamp}
                      style={{ fontSize: 16, fontWeight: 700, color: availableNow > 0n ? "var(--green)" : "var(--text)" }}
                    >
                      {formatAmount(availableNow)}
                    </div>
                  </div>

                  <div>
                    <div className="muted" style={{ fontSize: 11, textTransform: "uppercase" }}>Total Deposit</div>
                    <div className="mono" style={{ fontSize: 14 }}>{formatAmount(deposit)}</div>
                  </div>

                  <div>
                    <div className="muted" style={{ fontSize: 11, textTransform: "uppercase" }}>Claimed / Withdrawn</div>
                    <div className="mono" style={{ fontSize: 14, color: "var(--muted)" }}>{formatAmount(withdrawn)}</div>
                  </div>

                  <div>
                    <div className="muted" style={{ fontSize: 11, textTransform: "uppercase" }}>Window</div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>
                      {formatDate(s.startTime)} → {formatDate(s.endTime)}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    Token: {truncateAddress(s.token)}
                  </span>
                  <Link href={`/stream/${s.id}`} style={{ fontSize: 12, color: "var(--accent)" }}>
                    Inspect stream →
                  </Link>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* Cursor Pagination Bar */}
      <footer className="pagination-bar" aria-label="Pagination navigation">
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
      </footer>

      {/* Explorer Technical Invariant Callout */}
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
        StreamPay stream IDs are strictly monotonic and append-only. Cursor pagination partitions on
        immutable stream ID bounds rather than volatile record offsets, completely eliminating page-shift
        glitches and duplicated entries when streams are concurrently cancelled or completed.
      </aside>
    </main>
  );
}
