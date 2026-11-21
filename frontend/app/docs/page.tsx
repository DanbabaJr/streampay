"use client";

import Link from "next/link";
import Script from "next/script";
import { useCallback, useState } from "react";

export default function DocsPage() {
  const [swaggerReady, setSwaggerReady] = useState(false);

  const initSwagger = useCallback(() => {
    const win = window as unknown as {
      SwaggerUIBundle?: (config: Record<string, unknown>) => void;
    };
    if (win.SwaggerUIBundle) {
      win.SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [],
        layout: "BaseLayout",
      });
      setSwaggerReady(true);
    }
  }, []);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "2rem 1.5rem" }}>
      {/* Swagger UI styles */}
      <link
        rel="stylesheet"
        href="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui-css"
      />

      <Script
        src="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui-bundle.js"
        onReady={initSwagger}
      />

      {/* Header */}
      <div style={{ marginBottom: "2rem" }}>
        <Link
          href="/"
          style={{
            color: "#60a5fa",
            textDecoration: "none",
            fontSize: "0.875rem",
            display: "inline-block",
            marginBottom: "1rem",
          }}
        >
          ← Back to StreamPay App
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "2.25rem", fontWeight: 700, margin: 0 }}>
            ⚡ Accrual Curve API Docs
          </h1>
          <span
            style={{
              background: "#1e293b",
              color: "#38bdf8",
              padding: "0.25rem 0.75rem",
              borderRadius: "9999px",
              fontSize: "0.8125rem",
              fontWeight: 600,
              border: "1px solid #334155",
            }}
          >
            OpenAPI 3.1
          </span>
          <a
            href="/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: "#0284c7",
              color: "#ffffff",
              padding: "0.35rem 0.85rem",
              borderRadius: "6px",
              fontSize: "0.8125rem",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            Raw openapi.json ↗
          </a>
        </div>
        <p style={{ color: "#94a3b8", fontSize: "1.05rem", marginTop: "0.5rem" }}>
          Continuous on-the-fly accrual curves computed directly from contract state with ETag
          caching, honest staleness indicators, and shared RPC rate budgeting.
        </p>
      </div>

      {/* Architecture & Protocol Notes */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "1.5rem",
          marginBottom: "2.5rem",
        }}
      >
        <div
          style={{
            background: "#0f172a",
            border: "1px solid #1e293b",
            borderRadius: "8px",
            padding: "1.25rem",
          }}
        >
          <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem 0", color: "#38bdf8" }}>
            1. Computed, Never Stored
          </h3>
          <p style={{ color: "#cbd5e1", fontSize: "0.9rem", lineHeight: 1.5, margin: 0 }}>
            Curve points are derived in real-time using the contract’s exact pure math:
            <code style={{ display: "block", margin: "0.5rem 0", background: "#1e293b", padding: "0.4rem", borderRadius: "4px" }}>
              streamed(t) = deposit × elapsed / duration
            </code>
            Zero points are persisted in databases or files.
          </p>
        </div>

        <div
          style={{
            background: "#0f172a",
            border: "1px solid #1e293b",
            borderRadius: "8px",
            padding: "1.25rem",
          }}
        >
          <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem 0", color: "#38bdf8" }}>
            2. State Hash & ETag Caching
          </h3>
          <p style={{ color: "#cbd5e1", fontSize: "0.9rem", lineHeight: 1.5, margin: 0 }}>
            Response includes exact <code style={{ color: "#fcd34d" }}>X-State-Hash</code> computed as SHA-256 of on-chain state.
            ETag is derived from <code style={{ color: "#fcd34d" }}>hash:id:from:to:step</code>. Clients sending
            <code style={{ color: "#fcd34d" }}>If-None-Match</code> receive <code style={{ color: "#4ade80" }}>304 Not Modified</code> with zero payload.
          </p>
        </div>

        <div
          style={{
            background: "#0f172a",
            border: "1px solid #1e293b",
            borderRadius: "8px",
            padding: "1.25rem",
          }}
        >
          <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem 0", color: "#38bdf8" }}>
            3. Honest Staleness Headers
          </h3>
          <p style={{ color: "#cbd5e1", fontSize: "0.9rem", lineHeight: 1.5, margin: 0 }}>
            Every response discloses exact freshness: <code style={{ color: "#fcd34d" }}>X-As-Of-Ledger</code>,
            <code style={{ color: "#fcd34d" }}>X-As-Of-Timestamp</code>, and <code style={{ color: "#fcd34d" }}>Age</code>. If indexer lag exceeds threshold (&gt;60s), an explicit
            <code style={{ color: "#f87171" }}>Warning: 199</code> header is emitted.
          </p>
        </div>

        <div
          style={{
            background: "#0f172a",
            border: "1px solid #1e293b",
            borderRadius: "8px",
            padding: "1.25rem",
          }}
        >
          <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem 0", color: "#38bdf8" }}>
            4. Shared RPC Budget Manager (#56)
          </h3>
          <p style={{ color: "#cbd5e1", fontSize: "0.9rem", lineHeight: 1.5, margin: 0 }}>
            Calls draw from a unified rate budget protecting both node RPC quotas and per-client budgets.
            Exhaustion triggers <code style={{ color: "#f87171" }}>429 Too Many Requests</code> with a standard
            <code style={{ color: "#fcd34d" }}>Retry-After</code> header, serving stale cache when safe.
          </p>
        </div>
      </div>

      {/* Interactive Swagger UI Container */}
      <div
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          padding: "1.5rem",
          boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
        }}
      >
        <div id="swagger-ui">
          {!swaggerReady && (
            <p style={{ color: "#64748b", textAlign: "center", padding: "2rem" }}>
              Loading interactive OpenAPI schema viewer...
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
