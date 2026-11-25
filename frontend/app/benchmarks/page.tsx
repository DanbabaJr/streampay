"use client";

import Link from "next/link";
import { useState, useId } from "react";
import {
  BENCHMARK_METADATA,
  ECONOMIC_ASSUMPTIONS,
  STORAGE_AXIS,
  RENT_AXIS,
  OPERATIONS_BENCHMARK,
  CITATIONS,
  calculateLifecycleCost,
} from "@/lib/benchmark-data";

export default function BenchmarkDashboardPage() {
  const [unitMode, setUnitMode] = useState<"usd" | "native">("usd");
  const [durationDays, setDurationDays] = useState<number>(30);
  const [claimsCount, setClaimsCount] = useState<number>(4);
  const [depositUsd, setDepositUsd] = useState<number>(3000);
  const [rawCopied, setRawCopied] = useState<boolean>(false);

  const durationInputId = useId();
  const claimsInputId = useId();
  const depositInputId = useId();
  const unitToggleId = useId();

  const lifecycle = calculateLifecycleCost(durationDays, claimsCount, depositUsd);

  const copyRawJson = () => {
    const rawData = {
      metadata: BENCHMARK_METADATA,
      assumptions: ECONOMIC_ASSUMPTIONS,
      storage: STORAGE_AXIS,
      rent: RENT_AXIS,
      operations: OPERATIONS_BENCHMARK,
      citations: CITATIONS,
    };
    navigator.clipboard.writeText(JSON.stringify(rawData, null, 2));
    setRawCopied(true);
    setTimeout(() => setRawCopied(false), 2500);
  };

  return (
    <div style={{ maxWidth: 1160, margin: "0 auto", padding: "2.5rem 1.5rem 5rem" }}>
      {/* Navigation Header */}
      <nav aria-label="Breadcrumb" style={{ marginBottom: "1.5rem" }}>
        <Link
          href="/"
          id="back-home-link"
          style={{
            color: "var(--accent2)",
            textDecoration: "none",
            fontSize: "0.875rem",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            fontWeight: 500,
          }}
        >
          <span aria-hidden="true">←</span> Back to StreamPay App
        </Link>
      </nav>

      {/* Hero Section */}
      <header style={{ marginBottom: "2.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <span
            style={{
              background: "rgba(57, 197, 255, 0.12)",
              color: "var(--accent2)",
              padding: "0.25rem 0.75rem",
              borderRadius: "9999px",
              fontSize: "0.8125rem",
              fontWeight: 600,
              border: "1px solid rgba(57, 197, 255, 0.3)",
            }}
          >
            Public &amp; Reproducible
          </span>
          <span
            style={{
              background: "rgba(61, 220, 132, 0.12)",
              color: "var(--green)",
              padding: "0.25rem 0.75rem",
              borderRadius: "9999px",
              fontSize: "0.8125rem",
              fontWeight: 600,
              border: "1px solid rgba(61, 220, 132, 0.3)",
            }}
          >
            CI Verified Fresh
          </span>
          <span style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
            Updated: {BENCHMARK_METADATA.updatedAt}
          </span>
        </div>

        <h1 style={{ fontSize: "2.5rem", fontWeight: 800, margin: "0 0 1rem", letterSpacing: "-0.02em" }}>
          Protocol Streaming Benchmark
        </h1>
        <p style={{ color: "var(--muted)", fontSize: "1.125rem", lineHeight: 1.6, maxWidth: 840, margin: 0 }}>
          An open, mathematically normalized evaluation comparing <strong style={{ color: "var(--text)" }}>StreamPay</strong> (Stellar / Soroban)
          against <strong style={{ color: "var(--text)" }}>Sablier V2</strong> and <strong style={{ color: "var(--text)" }}>Superfluid CFA</strong> on the
          fundamental axes of streaming performance: storage footprint, ongoing state rent, claim efficiency, and cancellation settlement.
        </p>
      </header>

      {/* Interactive Controls & Normalization Toggle */}
      <section
        aria-labelledby="controls-heading"
        style={{
          background: "var(--panel)",
          border: "1px solid var(--line)",
          borderRadius: "14px",
          padding: "1.5rem",
          marginBottom: "2.5rem",
          display: "flex",
          flexWrap: "wrap",
          gap: "1.5rem",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <h2 id="controls-heading" style={{ fontSize: "1.1rem", margin: "0 0 0.35rem", color: "var(--text)" }}>
            Display &amp; Currency Mode
          </h2>
          <p style={{ color: "var(--muted)", fontSize: "0.875rem", margin: 0 }}>
            Toggle between real-world normalized USD fees and protocol-native execution metrics (Gas vs CPU Instructions vs Stroops).
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }} id={unitToggleId}>
          <button
            type="button"
            id="unit-mode-usd-btn"
            onClick={() => setUnitMode("usd")}
            style={{
              background: unitMode === "usd" ? "var(--accent)" : "rgba(255, 255, 255, 0.05)",
              color: unitMode === "usd" ? "#ffffff" : "var(--muted)",
              border: "1px solid " + (unitMode === "usd" ? "var(--accent)" : "var(--line)"),
              padding: "0.5rem 1rem",
              borderRadius: "8px",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
            aria-pressed={unitMode === "usd"}
          >
            💵 USD Normalized
          </button>
          <button
            type="button"
            id="unit-mode-native-btn"
            onClick={() => setUnitMode("native")}
            style={{
              background: unitMode === "native" ? "var(--accent)" : "rgba(255, 255, 255, 0.05)",
              color: unitMode === "native" ? "#ffffff" : "var(--muted)",
              border: "1px solid " + (unitMode === "native" ? "var(--accent)" : "var(--line)"),
              padding: "0.5rem 1rem",
              borderRadius: "8px",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
            aria-pressed={unitMode === "native"}
          >
            ⚡ Native Units (Gas / CPU)
          </button>
        </div>
      </section>

      {/* Interactive Stream Lifecycle Simulator */}
      <section
        aria-labelledby="simulator-heading"
        style={{
          background: "linear-gradient(180deg, var(--panel) 0%, rgba(17, 23, 37, 0.8) 100%)",
          border: "1px solid var(--line-light)",
          borderRadius: "16px",
          padding: "2rem",
          marginBottom: "3rem",
        }}
      >
        <div style={{ marginBottom: "1.75rem" }}>
          <h2 id="simulator-heading" style={{ fontSize: "1.45rem", margin: "0 0 0.5rem" }}>
            🧮 Interactive Stream Cost Simulator
          </h2>
          <p style={{ color: "var(--muted)", fontSize: "0.95rem", margin: 0 }}>
            Simulate total end-to-end lifecycle cost (Creation + Claims + State Rent / Collateral + Cancellation) for any stream configuration.
          </p>
        </div>

        {/* Input Controls */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: "1.5rem",
            marginBottom: "2rem",
          }}
        >
          <div>
            <label
              htmlFor={durationInputId}
              style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text)" }}
            >
              Stream Duration: <span style={{ color: "var(--accent2)" }}>{durationDays} Days</span>
            </label>
            <input
              id={durationInputId}
              type="range"
              min="1"
              max="365"
              step="1"
              value={durationDays}
              onChange={(e) => setDurationDays(Number(e.target.value))}
              style={{ width: "100%", accentColor: "var(--accent)" }}
            />
          </div>

          <div>
            <label
              htmlFor={claimsInputId}
              style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text)" }}
            >
              Claim Withdrawals: <span style={{ color: "var(--accent2)" }}>{claimsCount} Claims</span>
            </label>
            <input
              id={claimsInputId}
              type="range"
              min="0"
              max="60"
              step="1"
              value={claimsCount}
              onChange={(e) => setClaimsCount(Number(e.target.value))}
              style={{ width: "100%", accentColor: "var(--accent)" }}
            />
          </div>

          <div>
            <label
              htmlFor={depositInputId}
              style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text)" }}
            >
              Total Stream Deposit: <span style={{ color: "var(--accent2)" }}>${depositUsd.toLocaleString()} USD</span>
            </label>
            <input
              id={depositInputId}
              type="number"
              min="10"
              max="1000000"
              step="50"
              value={depositUsd}
              onChange={(e) => setDepositUsd(Math.max(10, Number(e.target.value)))}
              style={{
                width: "100%",
                background: "var(--bg)",
                border: "1px solid var(--line)",
                color: "var(--text)",
                padding: "0.55rem 0.75rem",
                borderRadius: "8px",
                fontSize: "0.95rem",
              }}
            />
          </div>
        </div>

        {/* Simulator Results Cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "1.25rem",
          }}
        >
          {/* StreamPay Card */}
          <div
            id="sim-streampay-card"
            style={{
              background: "rgba(139, 124, 255, 0.08)",
              border: "2px solid var(--accent)",
              borderRadius: "12px",
              padding: "1.25rem",
              position: "relative",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <span style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--accent)" }}>StreamPay</span>
              <span style={{ fontSize: "0.75rem", background: "var(--panel)", padding: "0.2rem 0.5rem", borderRadius: "4px" }}>Stellar</span>
            </div>
            <div style={{ fontSize: "1.85rem", fontWeight: 800, color: "#ffffff", marginBottom: "0.75rem" }}>
              ${lifecycle.streampay.totalUsd < 0.01 ? lifecycle.streampay.totalUsd.toFixed(4) : lifecycle.streampay.totalUsd.toFixed(2)}
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--muted)", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              <div>Create: ${lifecycle.streampay.createUsd.toFixed(6)}</div>
              <div>Claims ({claimsCount}×): ${lifecycle.streampay.claimsUsd.toFixed(6)}</div>
              <div>State Rent: ${lifecycle.streampay.rentUsd.toFixed(4)}</div>
              <div>Cancel: ${lifecycle.streampay.cancelUsd.toFixed(6)}</div>
            </div>
          </div>

          {/* Sablier L2 Card */}
          <div
            id="sim-sablier-l2-card"
            style={{
              background: "var(--bg)",
              border: "1px solid var(--line)",
              borderRadius: "12px",
              padding: "1.25rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <span style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text)" }}>Sablier V2</span>
              <span style={{ fontSize: "0.75rem", background: "var(--panel)", padding: "0.2rem 0.5rem", borderRadius: "4px" }}>Arbitrum L2</span>
            </div>
            <div style={{ fontSize: "1.85rem", fontWeight: 800, color: "var(--text)", marginBottom: "0.75rem" }}>
              ${lifecycle.sablierArbitrum.totalUsd.toFixed(2)}
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--muted)", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              <div>Create: ${lifecycle.sablierArbitrum.createUsd.toFixed(3)}</div>
              <div>Claims ({claimsCount}×): ${lifecycle.sablierArbitrum.claimsUsd.toFixed(3)}</div>
              <div>State Rent: $0.00 (Perpetual)</div>
              <div>Cancel: ${lifecycle.sablierArbitrum.cancelUsd.toFixed(3)}</div>
            </div>
          </div>

          {/* Superfluid L2 Card */}
          <div
            id="sim-superfluid-l2-card"
            style={{
              background: "var(--bg)",
              border: "1px solid var(--line)",
              borderRadius: "12px",
              padding: "1.25rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <span style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text)" }}>Superfluid CFA</span>
              <span style={{ fontSize: "0.75rem", background: "var(--panel)", padding: "0.2rem 0.5rem", borderRadius: "4px" }}>Arbitrum L2</span>
            </div>
            <div style={{ fontSize: "1.85rem", fontWeight: 800, color: "var(--text)", marginBottom: "0.75rem" }}>
              ${lifecycle.superfluidArbitrum.totalUsd.toFixed(2)}
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--muted)", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              <div>Create: ${lifecycle.superfluidArbitrum.createUsd.toFixed(3)}</div>
              <div>Claims: $0.00 (Passive Flow)</div>
              <div>Buffer Drag (5%): ${lifecycle.superfluidArbitrum.bufferOpportunityCostUsd.toFixed(3)}</div>
              <div>Cancel: ${lifecycle.superfluidArbitrum.cancelUsd.toFixed(3)}</div>
            </div>
          </div>

          {/* Sablier Ethereum L1 Card */}
          <div
            id="sim-sablier-l1-card"
            style={{
              background: "var(--bg)",
              border: "1px solid var(--line)",
              borderRadius: "12px",
              padding: "1.25rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <span style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text)" }}>Sablier V2</span>
              <span style={{ fontSize: "0.75rem", background: "var(--panel)", padding: "0.2rem 0.5rem", borderRadius: "4px" }}>Ethereum L1</span>
            </div>
            <div style={{ fontSize: "1.85rem", fontWeight: 800, color: "var(--red)", marginBottom: "0.75rem" }}>
              ${lifecycle.sablierEthereum.totalUsd.toFixed(2)}
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--muted)", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              <div>Create: ${lifecycle.sablierEthereum.createUsd.toFixed(2)}</div>
              <div>Claims ({claimsCount}×): ${lifecycle.sablierEthereum.claimsUsd.toFixed(2)}</div>
              <div>State Rent: $0.00 (Perpetual)</div>
              <div>Cancel: ${lifecycle.sablierEthereum.cancelUsd.toFixed(2)}</div>
            </div>
          </div>
        </div>
      </section>

      {/* Axis 1: Storage Bytes Per Stream */}
      <section aria-labelledby="storage-axis-heading" style={{ marginBottom: "3.5rem" }}>
        <h2 id="storage-axis-heading" style={{ fontSize: "1.6rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          Axis 1: Storage Bytes per Stream
        </h2>
        <p style={{ color: "var(--muted)", fontSize: "0.95rem", marginBottom: "1.25rem", lineHeight: 1.5 }}>
          Measures the persistent on-chain footprint allocated for a single stream. While EVM storage slots pack 32-byte words,
          Soroban persists entries via canonical XDR byte serialization.
        </p>

        <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: "12px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.9rem" }}>
            <caption className="sr-only">Storage bytes and layout comparison per stream</caption>
            <thead>
              <tr style={{ background: "var(--panel)", borderBottom: "1px solid var(--line)" }}>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Protocol</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Raw Data Bytes</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Keys / Slots</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Key Overhead</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Total Footprint</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>State Lifecycle Model</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(STORAGE_AXIS).map(([key, item], idx) => (
                <tr
                  key={key}
                  style={{
                    borderBottom: idx < 2 ? "1px solid var(--line)" : "none",
                    background: idx % 2 === 1 ? "rgba(255, 255, 255, 0.02)" : "transparent",
                  }}
                >
                  <th scope="row" style={{ padding: "0.85rem 1rem", fontWeight: 600, color: "var(--text)" }}>
                    {item.protocol}
                  </th>
                  <td style={{ padding: "0.85rem 1rem" }}>{item.rawStorageBytes} B</td>
                  <td style={{ padding: "0.85rem 1rem" }}>{item.keysOrSlotsCount} {key === "streampay" ? "entry key" : "EVM slots"}</td>
                  <td style={{ padding: "0.85rem 1rem" }}>{item.additionalOverheadBytes} B</td>
                  <td style={{ padding: "0.85rem 1rem", fontWeight: 700, color: key === "streampay" ? "var(--accent)" : "var(--text)" }}>
                    {item.totalEffectiveBytes} B
                  </td>
                  <td style={{ padding: "0.85rem 1rem", color: "var(--muted)" }}>{item.stateModel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Axis 2: Cost Per Second of Stream Life (Rent Economics) */}
      <section aria-labelledby="rent-axis-heading" style={{ marginBottom: "3.5rem" }}>
        <h2 id="rent-axis-heading" style={{ fontSize: "1.6rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          Axis 2: Cost per Second of Stream Life (State Rent)
        </h2>
        <p style={{ color: "var(--muted)", fontSize: "0.95rem", marginBottom: "1.25rem", lineHeight: 1.5 }}>
          Stellar utilizes <strong>State Archival</strong>: contracts pay ongoing rent to maintain state availability on validators.
          EVM systems front-load storage fees entirely at creation, resulting in $0/sec ongoing rent at the cost of global state bloat.
        </p>

        <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: "12px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.9rem" }}>
            <caption className="sr-only">Ongoing state rent and holding cost comparison</caption>
            <thead>
              <tr style={{ background: "var(--panel)", borderBottom: "1px solid var(--line)" }}>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Protocol</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Cost / Second</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Cost / 30-Day Month</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Prepaid Deposit / Buffer</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Maintenance Requirement</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(RENT_AXIS).map(([key, item], idx) => (
                <tr
                  key={key}
                  style={{
                    borderBottom: idx < 2 ? "1px solid var(--line)" : "none",
                    background: idx % 2 === 1 ? "rgba(255, 255, 255, 0.02)" : "transparent",
                  }}
                >
                  <th scope="row" style={{ padding: "0.85rem 1rem", fontWeight: 600, color: "var(--text)" }}>
                    {item.protocol}
                  </th>
                  <td style={{ padding: "0.85rem 1rem" }}>
                    {unitMode === "usd" ? `$${item.usdPerSecond.toFixed(10)}` : item.nativeCostPerSecond}
                  </td>
                  <td style={{ padding: "0.85rem 1rem", fontWeight: 700, color: key === "streampay" ? "var(--accent2)" : "var(--text)" }}>
                    {unitMode === "usd" ? `$${item.usdPer30Days.toFixed(4)}` : (key === "streampay" ? "2.51M stroops (0.25 XLM)" : "0 gas")}
                  </td>
                  <td style={{ padding: "0.85rem 1rem", color: "var(--muted)" }}>{item.prepaidBuffer}</td>
                  <td style={{ padding: "0.85rem 1rem", color: "var(--muted)", maxWidth: 300 }}>{item.maintenanceNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Axis 3 & 4: Claim and Cancel Operations Cost */}
      <section aria-labelledby="operations-axis-heading" style={{ marginBottom: "3.5rem" }}>
        <h2 id="operations-axis-heading" style={{ fontSize: "1.6rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          Axes 3 &amp; 4: Claim &amp; Cancel Execution Costs
        </h2>
        <p style={{ color: "var(--muted)", fontSize: "0.95rem", marginBottom: "1.25rem", lineHeight: 1.5 }}>
          Execution metering for hot-path balance withdrawals and premature cancellations.
          StreamPay executes on Soroban host CPU instructions, while Sablier and Superfluid consume EVM gas units.
        </p>

        {/* Claim Table */}
        <h3 style={{ fontSize: "1.15rem", fontWeight: 600, marginBottom: "0.75rem", color: "var(--accent)" }}>
          Withdraw Accrued Funds (Claim)
        </h3>
        <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: "12px", marginBottom: "2rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.9rem" }}>
            <caption className="sr-only">Claim withdrawal cost comparison</caption>
            <thead>
              <tr style={{ background: "var(--panel)", borderBottom: "1px solid var(--line)" }}>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Protocol &amp; Network</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Operation</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Native Metric</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Auxiliary Footprint</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Est. Fee (USD)</th>
              </tr>
            </thead>
            <tbody>
              {OPERATIONS_BENCHMARK.claim.map((item, idx) => (
                <tr
                  key={idx}
                  style={{
                    borderBottom: idx < OPERATIONS_BENCHMARK.claim.length - 1 ? "1px solid var(--line)" : "none",
                    background: idx % 2 === 1 ? "rgba(255, 255, 255, 0.02)" : "transparent",
                  }}
                >
                  <th scope="row" style={{ padding: "0.85rem 1rem", fontWeight: 600, color: "var(--text)" }}>
                    {item.protocol}
                  </th>
                  <td style={{ padding: "0.85rem 1rem", color: "var(--muted)" }}><code>{item.operationName}</code></td>
                  <td style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>
                    {item.nativeValue.toLocaleString()} {item.nativeMetric}
                  </td>
                  <td style={{ padding: "0.85rem 1rem", color: "var(--muted)" }}>{item.memoryOrAuxiliary}</td>
                  <td style={{ padding: "0.85rem 1rem", fontWeight: 700, color: "var(--green)" }}>
                    ${(item.usdFeeStellar ?? item.usdFeeL2 ?? item.usdFeeL1 ?? 0).toFixed(6)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Cancel Table */}
        <h3 style={{ fontSize: "1.15rem", fontWeight: 600, marginBottom: "0.75rem", color: "var(--accent)" }}>
          Cancel Stream (Settlement &amp; Refund)
        </h3>
        <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: "12px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.9rem" }}>
            <caption className="sr-only">Cancel stream operation cost comparison</caption>
            <thead>
              <tr style={{ background: "var(--panel)", borderBottom: "1px solid var(--line)" }}>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Protocol &amp; Network</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Operation</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Native Metric</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Auxiliary Footprint</th>
                <th scope="col" style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>Est. Fee (USD)</th>
              </tr>
            </thead>
            <tbody>
              {OPERATIONS_BENCHMARK.cancel.map((item, idx) => (
                <tr
                  key={idx}
                  style={{
                    borderBottom: idx < OPERATIONS_BENCHMARK.cancel.length - 1 ? "1px solid var(--line)" : "none",
                    background: idx % 2 === 1 ? "rgba(255, 255, 255, 0.02)" : "transparent",
                  }}
                >
                  <th scope="row" style={{ padding: "0.85rem 1rem", fontWeight: 600, color: "var(--text)" }}>
                    {item.protocol}
                  </th>
                  <td style={{ padding: "0.85rem 1rem", color: "var(--muted)" }}><code>{item.operationName}</code></td>
                  <td style={{ padding: "0.85rem 1rem", fontWeight: 600 }}>
                    {item.nativeValue.toLocaleString()} {item.nativeMetric}
                  </td>
                  <td style={{ padding: "0.85rem 1rem", color: "var(--muted)" }}>{item.memoryOrAuxiliary}</td>
                  <td style={{ padding: "0.85rem 1rem", fontWeight: 700, color: "var(--green)" }}>
                    ${(item.usdFeeStellar ?? item.usdFeeL2 ?? item.usdFeeL1 ?? 0).toFixed(6)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Inline Methodology Section (Mandatory Inline, not a link) */}
      <section
        aria-labelledby="methodology-heading"
        style={{
          background: "var(--panel)",
          border: "1px solid var(--line)",
          borderRadius: "16px",
          padding: "2rem",
          marginBottom: "3.5rem",
        }}
      >
        <div style={{ marginBottom: "1.5rem" }}>
          <span
            style={{
              background: "rgba(139, 124, 255, 0.15)",
              color: "var(--accent)",
              padding: "0.2rem 0.6rem",
              borderRadius: "4px",
              fontSize: "0.75rem",
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            Inline Technical Specification
          </span>
          <h2 id="methodology-heading" style={{ fontSize: "1.6rem", fontWeight: 700, margin: "0.5rem 0 0" }}>
            🔬 Cross-Chain Normalization &amp; Measurement Methodology
          </h2>
        </div>

        <div style={{ color: "var(--text)", lineHeight: 1.7, fontSize: "0.95rem" }}>
          <h3 style={{ fontSize: "1.15rem", color: "var(--accent2)", marginTop: "1rem" }}>
            1. The Fundamental Metering Disparity (EVM Gas vs Soroban Instructions)
          </h3>
          <p>
            EVM gas is an aggregated synthetic metric designed to compress three orthogonal dimensions—computational execution (opcodes),
            transient volatile memory (expansion), and permanent disk storage (<code style={{ color: "var(--accent)" }}>SSTORE</code>)—into a single scalar.
            Because Ethereum historically lacked storage rent, the EVM punishes new storage writes with a steep 20,000 gas cliff (~$12 on L1)
            to disincentivize validator disk exhaustion.
          </p>
          <p>
            Conversely, Stellar&apos;s Soroban host meters each resource independently based on actual hardware costs:
          </p>
          <ul style={{ paddingLeft: "1.5rem", color: "var(--muted)" }}>
            <li><strong>CPU Instructions</strong>: Monitored via the WebAssembly fuel counter (100,000,000 instruction transaction budget).</li>
            <li><strong>Memory Bytes</strong>: Volatile memory allocations metered separately from instruction budget.</li>
            <li><strong>Ledger Read/Write Bytes</strong>: Serialized XDR byte payload lengths recorded directly against disk bandwidth quotas.</li>
            <li><strong>State Archival Rent</strong>: Explicit per-byte per-ledger holding fee ensuring dormant entries do not bloat full nodes.</li>
          </ul>

          <h3 style={{ fontSize: "1.15rem", color: "var(--accent2)", marginTop: "1.5rem" }}>
            2. State Archival Rent Formula &amp; TTL Invariant
          </h3>
          <p>
            In Soroban Protocol 20/21, persistent storage rent is governed by the consensus parameter:
            <code style={{ background: "var(--bg)", padding: "0.2rem 0.4rem", borderRadius: "4px", marginLeft: "0.3rem" }}>
              rate = 0.01 stroops / byte / ledger
            </code>
            (1 stroop = 0.0000001 XLM).
            With target ledger close time <code style={{ background: "var(--bg)", padding: "0.2rem 0.4rem", borderRadius: "4px" }}>T = 5.0 s</code> (0.2 ledgers / second),
            the continuous rent formula for a StreamPay stream (484 bytes) is:
          </p>
          <div
            style={{
              background: "var(--bg)",
              padding: "1rem",
              borderRadius: "8px",
              fontFamily: "monospace",
              fontSize: "0.9rem",
              border: "1px solid var(--line)",
              margin: "0.75rem 0",
            }}
          >
            Rent = 484 bytes × 0.01 stroops/byte/ledger × 0.2 ledgers/s = 0.968 stroops / second
            <br />
            Rent (30 Days) = 0.968 × 86,400 s/day × 30 days = 2,509,056 stroops ≈ 0.2509 XLM (~$0.0301 USD)
          </div>
          <p style={{ color: "var(--muted)" }}>
            StreamPay implements automatic TTL extension: every stream entry is initialized with 500,000 ledgers (~29 days) of prepaid TTL.
            Every mutating interaction (<code style={{ color: "var(--text)" }}>withdraw</code>, <code style={{ color: "var(--text)" }}>top_up</code>,
            <code style={{ color: "var(--text)" }}>cancel_stream</code>) extends the entry&apos;s TTL back to 500,000 ledgers if it drops below 200,000 ledgers.
            This ensures that active streams never risk state archival while maintaining honest on-chain rent accounting.
          </p>

          <h3 style={{ fontSize: "1.15rem", color: "var(--accent2)", marginTop: "1.5rem" }}>
            3. Solvency &amp; Claim Mechanics: Discrete Escrow vs Continuous Flow
          </h3>
          <p>
            StreamPay and Sablier employ a <strong>Discrete Escrow</strong> architecture: 100% of the stream principal is transferred into the contract
            at inception. This guarantees absolute mathematical solvency—a stream can never fail to pay out regardless of external market conditions.
            The tradeoff is that recipients must execute an explicit claim transaction to withdraw accrued tokens.
          </p>
          <p>
            Superfluid employs a <strong>Continuous Flow</strong> architecture: token balances update in real-time as a dynamic derivative of timestamp.
            Recipients experience <strong>0-gas claims</strong> because tokens are spendable directly without an on-chain transaction.
            However, this requires senders to maintain continuous positive balances and lock a mandatory 4-hour liquidation buffer deposit.
            If a sender account runs dry, off-chain liquidation bots (TOPIAC / PICASSO) execute forced closures and confiscate the buffer.
          </p>

          <h3 style={{ fontSize: "1.15rem", color: "var(--accent2)", marginTop: "1.5rem" }}>
            4. Methodology Dispute &amp; Contribution Process
          </h3>
          <p style={{ margin: 0 }}>
            All competitor numbers are dated, cited against published audit reports, and linked to verified mainnet contracts.
            If you represent a competitor protocol or believe any gas profile, storage packing model, or normalization parameter is inaccurate:
          </p>
          <ol style={{ paddingLeft: "1.5rem", color: "var(--muted)", marginTop: "0.5rem" }}>
            <li>Fork the StreamPay repository and check out a branch: <code>git checkout -b dispute/benchmark-update</code>.</li>
            <li>Submit a reproducible test script (e.g. Foundry <code>forge test --gas-report</code> or Hardhat trace) updating <code>benchmarks/data/competitors.json</code>.</li>
            <li>Open a PR titled <code>benchmark: dispute &lt;protocol or metric&gt;</code> with link to verified on-chain deployment.</li>
          </ol>
        </div>
      </section>

      {/* Primary Sources & Citations Table */}
      <section aria-labelledby="citations-heading" style={{ marginBottom: "3.5rem" }}>
        <h2 id="citations-heading" style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          📚 Competitor References &amp; Audit Citations
        </h2>
        <p style={{ color: "var(--muted)", fontSize: "0.95rem", marginBottom: "1.25rem" }}>
          All benchmark parameters are sourced from audited canonical releases and verified block explorer deployments.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1.25rem" }}>
          {CITATIONS.map((cit, idx) => (
            <div
              key={idx}
              style={{
                background: "var(--panel)",
                border: "1px solid var(--line)",
                borderRadius: "12px",
                padding: "1.25rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.5rem" }}>
                <h3 style={{ fontSize: "1.05rem", fontWeight: 700, margin: 0, color: "var(--text)" }}>
                  {cit.protocol}
                </h3>
                <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Verified: {cit.lastVerifiedDate}</span>
              </div>
              <div style={{ fontSize: "0.85rem", color: "var(--accent)", marginBottom: "0.75rem" }}>
                <code>{cit.contractName}</code> ({cit.commitOrVersion})
              </div>

              <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginBottom: "0.75rem" }}>
                <strong>Source:</strong>{" "}
                <a
                  href={cit.repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--accent2)", textDecoration: "none" }}
                >
                  {cit.repositoryUrl.replace("https://github.com/", "")} ↗
                </a>
              </div>

              <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginBottom: "0.5rem" }}>
                <strong>Audits:</strong> {cit.auditReferences.join(" • ")}
              </div>

              <div style={{ fontSize: "0.75rem", color: "var(--muted)", borderTop: "1px solid var(--line)", paddingTop: "0.5rem" }}>
                <strong>Deployments:</strong>
                {Object.entries(cit.contractAddresses).map(([net, addr]) => (
                  <div key={net} style={{ marginTop: "0.2rem", wordBreak: "break-all" }}>
                    <span style={{ color: "var(--text)" }}>{net}:</span> <code>{addr}</code>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Reproducibility Harness & Raw Data Export */}
      <section
        aria-labelledby="reproducibility-heading"
        style={{
          background: "var(--bg)",
          border: "1px solid var(--line)",
          borderRadius: "14px",
          padding: "1.75rem",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem", marginBottom: "1rem" }}>
          <div>
            <h2 id="reproducibility-heading" style={{ fontSize: "1.3rem", fontWeight: 700, margin: "0 0 0.35rem" }}>
              💻 Run the Measurement Harness Yourself
            </h2>
            <p style={{ color: "var(--muted)", fontSize: "0.875rem", margin: 0 }}>
              Execute the deterministic Soroban measurement harness locally to independently reproduce every number.
            </p>
          </div>

          <button
            type="button"
            id="copy-raw-json-btn"
            onClick={copyRawJson}
            style={{
              background: rawCopied ? "var(--green)" : "var(--panel)",
              color: rawCopied ? "#000000" : "var(--text)",
              border: "1px solid var(--line-light)",
              padding: "0.5rem 1rem",
              borderRadius: "8px",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.2s ease",
            }}
          >
            {rawCopied ? "✓ JSON Copied!" : "📋 Copy Raw JSON"}
          </button>
        </div>

        <div
          style={{
            background: "var(--panel)",
            padding: "1rem",
            borderRadius: "8px",
            border: "1px solid var(--line)",
            fontFamily: "monospace",
            fontSize: "0.85rem",
            overflowX: "auto",
          }}
        >
          <div style={{ color: "var(--muted)", marginBottom: "0.3rem" }}># Clone and run Soroban measurement harness:</div>
          <div style={{ color: "var(--green)" }}>cargo run -p streampay-contract --example protocol_benchmark -- --json</div>
          <div style={{ color: "var(--muted)", margin: "0.75rem 0 0.3rem" }}># Run the CI regression defense gate:</div>
          <div style={{ color: "var(--green)" }}>npm run benchmark:verify</div>
        </div>
      </section>
    </div>
  );
}
