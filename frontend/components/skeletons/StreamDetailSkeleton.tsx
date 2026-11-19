import { Skeleton } from "./Skeleton";

export interface StreamDetailSkeletonProps {
  streamId?: string;
}

/**
 * Layout-matched loading skeleton for the Stream Detail route (/stream/[id]).
 * Mirrors header, progress bar, metadata table, and action panels.
 */
export function StreamDetailSkeleton({ streamId }: StreamDetailSkeletonProps) {
  return (
    <main className="wrap" aria-busy="true" aria-label="Loading stream details" role="status">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <p className="kicker mono">
          {streamId ? `STREAM #${streamId}` : <Skeleton width="110px" height="14px" />}
        </p>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "2px 8px",
            borderRadius: "999px",
            border: "1px solid rgba(255, 255, 255, 0.1)",
          }}
        >
          <Skeleton width="50px" height="12px" />
        </span>
      </div>

      <h1 style={{ display: "flex", alignItems: "center", gap: "8px", margin: "4px 0 16px" }}>
        <Skeleton width="220px" height="38px" />
      </h1>

      {/* Main Stream Details Card */}
      <section className="card" style={{ marginBottom: "20px" }}>
        <div className="row" style={{ alignItems: "center", marginBottom: "16px" }}>
          <Skeleton height="14px" style={{ flex: 1 }} borderRadius="8px" />
          <Skeleton width="100px" height="14px" />
        </div>
        <table>
          <tbody>
            <tr>
              <th>Sender</th>
              <td className="mono">
                <Skeleton width="75%" height="16px" />
              </td>
            </tr>
            <tr>
              <th>Recipient</th>
              <td className="mono">
                <Skeleton width="75%" height="16px" />
              </td>
            </tr>
            <tr>
              <th>Token</th>
              <td className="mono">
                <Skeleton width="65%" height="16px" />
              </td>
            </tr>
            <tr>
              <th>Deposit</th>
              <td className="mono">
                <Skeleton width="45%" height="16px" />
              </td>
            </tr>
            <tr>
              <th>Withdrawn</th>
              <td className="mono">
                <Skeleton width="40%" height="16px" />
              </td>
            </tr>
            <tr>
              <th>Available now</th>
              <td className="mono">
                <Skeleton width="50%" height="16px" />
              </td>
            </tr>
            <tr>
              <th>Status</th>
              <td className="mono">
                <Skeleton width="30%" height="16px" />
              </td>
            </tr>
            <tr>
              <th>Duration</th>
              <td className="mono">
                <Skeleton width="55%" height="16px" />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Action Card: Withdraw & Controls */}
      <section className="card">
        <div style={{ marginBottom: "16px" }}>
          <Skeleton width="180px" height="24px" />
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <Skeleton height="40px" style={{ flex: 1 }} borderRadius="6px" />
          <Skeleton width="110px" height="40px" borderRadius="6px" />
          <Skeleton width="130px" height="40px" borderRadius="6px" />
        </div>
      </section>

      <div style={{ marginTop: "24px" }}>
        <Skeleton width="120px" height="16px" />
      </div>
    </main>
  );
}

export default StreamDetailSkeleton;
