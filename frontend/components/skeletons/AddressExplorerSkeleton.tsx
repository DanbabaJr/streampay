import { Skeleton } from "./Skeleton";

export interface AddressExplorerSkeletonProps {
  address?: string;
}

/**
 * Layout-matched loading skeleton for the Address Explorer route (/address/[addr]).
 * Mirrors header, aggregate stats grid, filter controls, and stream cards list.
 */
export function AddressExplorerSkeleton({ address }: AddressExplorerSkeletonProps) {
  return (
    <main className="wrap" aria-busy="true" aria-label="Loading address explorer" role="status">
      <div style={{ marginBottom: "16px" }}>
        <Skeleton width="130px" height="16px" />
      </div>

      <header style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1 style={{ margin: "0 0 4px 0", fontSize: 26 }}>Address Explorer</h1>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "rgba(61, 220, 132, 0.1)",
                  border: "1px solid rgba(61, 220, 132, 0.25)",
                  padding: "4px 10px",
                  borderRadius: "999px",
                  fontSize: "12px",
                  color: "var(--green)",
                }}
              >
                <Skeleton width="34px" height="12px" />
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              {address ? (
                <span className="mono" style={{ fontSize: 14, color: "var(--text)", wordBreak: "break-all" }}>
                  {address}
                </span>
              ) : (
                <Skeleton width="340px" height="18px" />
              )}
              <Skeleton width="56px" height="26px" borderRadius="4px" />
            </div>
          </div>

          <div style={{ textAlign: "right" }}>
            <Skeleton width="140px" height="14px" />
          </div>
        </div>
      </header>

      {/* Aggregate Stats Grid (4 boxes) */}
      <section className="stats-grid" aria-label="Address stream aggregates placeholder">
        <div className="stat-box">
          <span className="stat-label">Total Streams</span>
          <Skeleton width="50px" height="26px" style={{ marginTop: "4px" }} />
        </div>
        <div className="stat-box">
          <span className="stat-label">Active Streams</span>
          <Skeleton width="50px" height="26px" style={{ marginTop: "4px" }} />
        </div>
        <div className="stat-box">
          <span className="stat-label">Total Deposited</span>
          <Skeleton width="90px" height="26px" style={{ marginTop: "4px" }} />
        </div>
        <div className="stat-box">
          <span className="stat-label">Total Claimed</span>
          <Skeleton width="90px" height="26px" style={{ marginTop: "4px" }} />
        </div>
      </section>

      {/* Navigation & Filter Controls */}
      <nav className="filter-controls" aria-label="Filter streams placeholder">
        <div className="filter-group">
          <Skeleton width="90px" height="32px" borderRadius="4px" />
          <Skeleton width="145px" height="32px" borderRadius="4px" />
          <Skeleton width="135px" height="32px" borderRadius="4px" />
        </div>
        <div className="filter-group">
          <Skeleton width="85px" height="32px" borderRadius="4px" />
          <Skeleton width="90px" height="32px" borderRadius="4px" />
          <Skeleton width="70px" height="32px" borderRadius="4px" />
        </div>
      </nav>

      {/* Matching Count Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 16px" }}>
        <Skeleton width="180px" height="14px" />
      </div>

      {/* Stream Card Placeholders (3 cards) */}
      <div className="stream-list">
        {[1, 2, 3].map((idx) => (
          <article key={idx} className="stream-card">
            <div className="stream-card-header">
              <Skeleton width="120px" height="20px" />
              <Skeleton width="75px" height="22px" borderRadius="999px" />
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px",
                marginBottom: "12px",
              }}
            >
              <div>
                <Skeleton width="45px" height="12px" style={{ marginBottom: "4px" }} />
                <Skeleton width="90%" height="16px" />
              </div>
              <div>
                <Skeleton width="60px" height="12px" style={{ marginBottom: "4px" }} />
                <Skeleton width="90%" height="16px" />
              </div>
            </div>
            <div style={{ marginTop: "8px" }}>
              <Skeleton height="10px" style={{ width: "100%", marginBottom: "8px" }} borderRadius="6px" />
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <Skeleton width="100px" height="14px" />
                <Skeleton width="120px" height="14px" />
              </div>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}

export default AddressExplorerSkeleton;
