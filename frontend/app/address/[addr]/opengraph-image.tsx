import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "StreamPay Address Explorer";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default async function Image({
  params,
}: {
  params: Promise<{ addr: string }>;
}) {
  const { addr } = await params;
  const shortAddr =
    addr && addr.length > 12
      ? `${addr.slice(0, 8)}…${addr.slice(-8)}`
      : addr || "Stellar Address";

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "space-between",
          backgroundColor: "#0a0e16",
          padding: "60px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #8b7cff, #39c5ff)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#06080d",
              fontSize: 24,
              fontWeight: 900,
            }}
          >
            S
          </div>
          <div
            style={{
              fontSize: 32,
              fontWeight: 800,
              color: "#e8eefb",
              letterSpacing: -1,
            }}
          >
            StreamPay <span style={{ color: "#39c5ff" }}>Explorer</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: "rgba(61, 220, 132, 0.15)",
              border: "1px solid rgba(61, 220, 132, 0.3)",
              padding: "6px 16px",
              borderRadius: 999,
              color: "#3ddc84",
              fontSize: 18,
              fontWeight: 600,
            }}
          >
            Live Accrual Engine • Stellar Soroban
          </div>

          <div
            style={{
              fontSize: 52,
              fontWeight: 800,
              color: "#ffffff",
              fontFamily: "monospace",
              letterSpacing: -1,
            }}
          >
            {shortAddr}
          </div>

          <div
            style={{
              fontSize: 22,
              color: "#93a1b8",
              maxWidth: 900,
              lineHeight: 1.4,
            }}
          >
            Continuous per-second payment streams, real-time balances, and
            immutable cursor-paginated payment history.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            width: "100%",
            borderTop: "1px solid #22304a",
            paddingTop: 24,
            color: "#93a1b8",
            fontSize: 18,
          }}
        >
          <span>Stellar Mainnet & Testnet</span>
          <span>streampay.finance/address</span>
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
