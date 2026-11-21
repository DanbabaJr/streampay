import { Skeleton } from "./Skeleton";

/**
 * Layout-matched loading skeleton for the Dashboard / Home route (/ or /dashboard).
 * Mirrors title, navigation links, stream creation form cards, and stream list.
 */
export function DashboardSkeleton() {
  return (
    <main className="wrap" aria-busy="true" aria-label="Loading dashboard" role="status">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          marginBottom: "12px",
        }}
      >
        <div>
          <div className="kicker mono">
            <Skeleton width="120px" height="12px" />
          </div>
          <h1 style={{ margin: "4px 0 8px" }}>
            <Skeleton width="260px" height="38px" />
          </h1>
        </div>

        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          <Skeleton width="90px" height="18px" />
          <Skeleton width="60px" height="18px" />
          <Skeleton width="50px" height="18px" />
          <Skeleton width="130px" height="36px" borderRadius="6px" />
        </div>
      </div>

      <p className="muted" style={{ marginBottom: "24px" }}>
        <Skeleton width="380px" height="16px" />
      </p>

      {/* Create Stream Form Card */}
      <section className="card" style={{ marginBottom: "20px" }}>
        <div style={{ marginBottom: "16px" }}>
          <Skeleton width="180px" height="24px" />
        </div>
        <div style={{ display: "grid", gap: "14px" }}>
          <div>
            <Skeleton width="80px" height="14px" style={{ marginBottom: "6px" }} />
            <Skeleton height="40px" style={{ width: "100%" }} borderRadius="6px" />
          </div>
          <div>
            <Skeleton width="70px" height="14px" style={{ marginBottom: "6px" }} />
            <Skeleton height="40px" style={{ width: "100%" }} borderRadius="6px" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div>
              <Skeleton width="60px" height="14px" style={{ marginBottom: "6px" }} />
              <Skeleton height="40px" style={{ width: "100%" }} borderRadius="6px" />
            </div>
            <div>
              <Skeleton width="90px" height="14px" style={{ marginBottom: "6px" }} />
              <Skeleton height="40px" style={{ width: "100%" }} borderRadius="6px" />
            </div>
          </div>
          <div style={{ marginTop: "8px" }}>
            <Skeleton width="140px" height="42px" borderRadius="6px" />
          </div>
        </div>
      </section>

      {/* Fetch Stream by ID Card */}
      <section className="card" style={{ marginBottom: "20px" }}>
        <div style={{ marginBottom: "14px" }}>
          <Skeleton width="160px" height="22px" />
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <Skeleton height="40px" style={{ flex: 1 }} borderRadius="6px" />
          <Skeleton width="90px" height="40px" borderRadius="6px" />
        </div>
      </section>

      {/* Streams List Card */}
      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <Skeleton width="120px" height="22px" />
          <Skeleton width="80px" height="14px" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {[1, 2].map((idx) => (
            <div
              key={idx}
              style={{
                padding: "14px",
                border: "1px solid var(--line)",
                borderRadius: "8px",
                background: "rgba(255, 255, 255, 0.02)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                <Skeleton width="110px" height="18px" />
                <Skeleton width="60px" height="18px" borderRadius="999px" />
              </div>
              <Skeleton width="90%" height="14px" style={{ marginBottom: "8px" }} />
              <Skeleton height="8px" style={{ width: "100%" }} borderRadius="4px" />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

export default DashboardSkeleton;
