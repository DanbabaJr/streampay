"use client";

/**
 * Output panes for the transaction builder.
 *
 * The footprint is displayed explicitly (read-only and read-write ledger keys,
 * plus the resource budget) because that is the part of a Soroban simulation
 * response that is hardest to read from raw JSON.
 */
import type { ExecutionReport, SimulationReport } from "@/lib/tx-builder/report";

export interface TxBuilderOutput {
  kind: "simulation" | "execution";
  functionName: string;
  unsignedXdr: string;
  preparedXdr?: string;
  simulation: SimulationReport;
  execution?: ExecutionReport;
}

export interface OutputPaneProps {
  output: TxBuilderOutput | null;
  error: string | null;
  busy: boolean;
}

function CodeBlock({ title, value }: { title: string; value: string }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ marginBottom: 4 }}>
        {title}
      </div>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: 10,
          background: "#0d1320",
          border: "1px solid var(--line)",
          borderRadius: 8,
          maxHeight: 260,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontSize: 12,
        }}
      >
        {value}
      </pre>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return <CodeBlock title={title} value={JSON.stringify(value, null, 2)} />;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-box">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

export default function OutputPane({ output, error, busy }: OutputPaneProps) {
  return (
    <section className="card" aria-live="polite" aria-busy={busy}>
      <h2 style={{ marginTop: 0 }}>Output</h2>
      {busy && <p className="muted">Waiting for Soroban RPC…</p>}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {!output && !error && !busy && (
        <p className="muted">
          Simulate a call to see the assembled transaction XDR, resource
          footprint, return value and emitted events.
        </p>
      )}

      {output && (
        <>
          <p className="muted">
            <code>{output.functionName}</code>{" "}
            {output.kind === "execution" ? "submitted to Testnet" : "simulated against Testnet"}.
          </p>

          <CodeBlock
            title={
              output.preparedXdr
                ? "Assembled transaction XDR (with Soroban resource data)"
                : "Unsigned transaction XDR"
            }
            value={output.preparedXdr ?? output.unsignedXdr}
          />

          <h3>Simulation</h3>
          {!output.simulation.ok ? (
            <p className="err" role="alert">
              Simulation failed: {output.simulation.error}
            </p>
          ) : (
            <>
              <div className="stats-grid">
                <Metric
                  label="Min resource fee"
                  value={output.simulation.minResourceFee ?? "—"}
                />
                <Metric
                  label="Instructions"
                  value={output.simulation.footprint?.instructions ?? "—"}
                />
                <Metric
                  label="Disk read bytes"
                  value={output.simulation.footprint?.diskReadBytes ?? "—"}
                />
                <Metric
                  label="Write bytes"
                  value={output.simulation.footprint?.writeBytes ?? "—"}
                />
                <Metric
                  label="Read-only keys"
                  value={output.simulation.footprint?.readOnly.length ?? 0}
                />
                <Metric
                  label="Read-write keys"
                  value={output.simulation.footprint?.readWrite.length ?? 0}
                />
              </div>
              {output.simulation.needsRestore && (
                <p className="warn" role="alert">
                  Simulation requires a restore preamble before this call can be
                  submitted. Restore the archived entries first.
                </p>
              )}
              <JsonBlock title="Return value" value={output.simulation.returnValue ?? null} />
              {output.simulation.returnValueXdr && (
                <CodeBlock title="Return value XDR" value={output.simulation.returnValueXdr} />
              )}
              <details style={{ marginTop: 12 }}>
                <summary className="muted" style={{ cursor: "pointer" }}>
                  Footprint ledger keys
                </summary>
                <JsonBlock
                  title="Read-only ledger keys (base64 XDR)"
                  value={output.simulation.footprint?.readOnly ?? []}
                />
                <JsonBlock
                  title="Read-write ledger keys (base64 XDR)"
                  value={output.simulation.footprint?.readWrite ?? []}
                />
              </details>
              <details style={{ marginTop: 12 }}>
                <summary className="muted" style={{ cursor: "pointer" }}>
                  Raw simulation transaction data (base64 XDR)
                </summary>
                <CodeBlock
                  title="SorobanTransactionData"
                  value={output.simulation.transactionDataXdr ?? ""}
                />
              </details>
              <JsonBlock
                title={`Emitted events (${output.simulation.events.length} of ${output.simulation.rawEventCount} raw)`}
                value={output.simulation.events}
              />
            </>
          )}

          {output.execution && (
            <>
              <h3>Execution</h3>
              <div className="stats-grid">
                <Metric label="Status" value={output.execution.status} />
                <Metric label="Ledger" value={output.execution.ledger ?? "—"} />
              </div>
              <CodeBlock title="Transaction hash" value={output.execution.hash} />
              <JsonBlock title="Return value" value={output.execution.returnValue ?? null} />
              {output.execution.returnValueXdr && (
                <CodeBlock title="Return value XDR" value={output.execution.returnValueXdr} />
              )}
              {output.execution.resultXdr && (
                <CodeBlock title="Transaction result XDR" value={output.execution.resultXdr} />
              )}
              <JsonBlock
                title={`Contract events (${output.execution.events.length})`}
                value={output.execution.events}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
