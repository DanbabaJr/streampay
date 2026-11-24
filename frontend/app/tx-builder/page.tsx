"use client";

/**
 * Spec-driven Soroban transaction builder (issue #97).
 *
 * Integrators can select any current contract entrypoint, fill a form generated
 * from the canonical spec (including nested vectors/options/structs/enums),
 * simulate it against Testnet, inspect the footprint/events/return value, and
 * optionally sign and submit it with the connected wallet.
 *
 * The safety gate is evaluated before the form renders: a PUBLIC app network or
 * a mainnet/unknown RPC endpoint gets a loud, non-dismissible refusal instead of
 * a transaction builder.
 */
import { useState } from "react";
import Link from "next/link";
import {
  Networks,
  StrKey,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { useWallet } from "@/lib/wallet-context";
import { APP_CONTRACT_ID, APP_NETWORK_LABEL } from "@/lib/network";
import {
  CONTRACT_SPEC,
  SPEC_FUNCTIONS,
  SPEC_SOURCE,
  getFunctionSpec,
} from "@/lib/tx-builder/spec";
import { assessSandboxSafety } from "@/lib/tx-builder/safety";
import {
  SANDBOX_RPC_URL,
  buildTransaction,
} from "@/lib/tx-builder/transaction";
import { defaultArgsForFunction, type TxValue } from "@/lib/tx-builder/values";
import { summarizeExecution, summarizeSimulation } from "@/lib/tx-builder/report";
import ArgField from "@/components/tx-builder/ArgField";
import OutputPane, { type TxBuilderOutput } from "@/components/tx-builder/OutputPane";
import { useToast } from "@/components/toast";
import { useT } from "@/lib/i18n/provider";

const SAFETY = assessSandboxSafety(APP_NETWORK_LABEL, SANDBOX_RPC_URL);
const DEFAULT_FUNCTION = SPEC_FUNCTIONS.find((entry) => entry.name === "create_stream")?.name
  ?? SPEC_FUNCTIONS[0]?.name
  ?? "";

type Busy = "idle" | "simulate" | "submit";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function BlockedPage() {
  return (
    <main className="wrap">
      <p>
        <Link href="/" style={{ color: "var(--accent2)", textDecoration: "none" }}>
          ← Back to StreamPay
        </Link>
      </p>
      <div className="kicker mono" style={{ color: "var(--red)", letterSpacing: "0.15em" }}>
        SANDBOX REFUSED
      </div>
      <h1>Transaction builder blocked</h1>
      <div
        className="card"
        role="alert"
        style={{ borderColor: "var(--red)", background: "rgba(255, 107, 107, 0.08)" }}
      >
        <h2 style={{ color: "var(--red)", marginTop: 0 }}>
          This page only builds and submits Stellar Testnet transactions.
        </h2>
        <ul>
          {SAFETY.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          Fix the network configuration before using the sandbox. Set
          <code> NEXT_PUBLIC_NETWORK=TESTNET </code> and point
          <code> NEXT_PUBLIC_SOROBAN_RPC_URL </code> at an explicit Testnet or local
          Soroban RPC endpoint. No form is rendered while this refusal is active.
        </p>
      </div>
    </main>
  );
}

export default function TxBuilderPage() {
  if (!SAFETY.safe) return <BlockedPage />;
  return <TxBuilder />;
}

function TxBuilder() {
  const { address, signTransaction } = useWallet();
  const toast = useToast();
  const t = useT();
  const [contractId, setContractId] = useState(APP_CONTRACT_ID);
  const [source, setSource] = useState("");
  const [functionName, setFunctionName] = useState(DEFAULT_FUNCTION);
  const [values, setValues] = useState<Record<string, TxValue>>(() =>
    defaultArgsForFunction(CONTRACT_SPEC, DEFAULT_FUNCTION),
  );
  const [busy, setBusy] = useState<Busy>("idle");
  const [output, setOutput] = useState<TxBuilderOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A connected wallet is the natural source for a sandbox call, but the field
  // stays editable so a developer can simulate from another account. The
  // "Use wallet" button fills it without an effect (which would cascade renders).
  const fn = getFunctionSpec(functionName);

  function reportError(message: string) {
    setError(message);
    toast.error(message);
  }

  function selectFunction(nextName: string) {
    setFunctionName(nextName);
    setValues(defaultArgsForFunction(CONTRACT_SPEC, nextName));
    setOutput(null);
    setError(null);
  }

  function updateArg(name: string, next: TxValue) {
    setValues((previous) => ({ ...previous, [name]: next }));
  }

  function validateInputs():
    | { ok: true; contractId: string; source: string }
    | { ok: false; error: string } {
    const cleanContract = contractId.trim();
    const cleanSource = source.trim();
    if (!cleanContract) {
      return { ok: false, error: t("txBuilder.contractRequired") };
    }
    if (!StrKey.isValidContract(cleanContract)) {
      return {
        ok: false,
        error: t("txBuilder.contractInvalid"),
      };
    }
    if (!cleanSource) {
      return { ok: false, error: t("txBuilder.sourceRequired") };
    }
    if (!StrKey.isValidEd25519PublicKey(cleanSource)) {
      return {
        ok: false,
        error: t("txBuilder.sourceInvalid"),
      };
    }
    if (!fn) {
      return { ok: false, error: t("txBuilder.functionRequired") };
    }
    return { ok: true, contractId: cleanContract, source: cleanSource };
  }

  async function handleSimulate() {
    setError(null);
    setOutput(null);
    setBusy("simulate");
    try {
      const checked = validateInputs();
      if (!checked.ok) {
        reportError(checked.error);
        return;
      }
      const server = new rpc.Server(SANDBOX_RPC_URL);
      const tx = buildTransaction({
        spec: CONTRACT_SPEC,
        contractId: checked.contractId,
        source: checked.source,
        functionName,
        values,
      });
      const simulation = await server.simulateTransaction(tx);
      const summary = summarizeSimulation(simulation);
      setOutput({
        kind: "simulation",
        functionName,
        unsignedXdr: tx.toXDR(),
        simulation: summary,
      });
      if (!summary.ok) {
        reportError(t("txBuilder.simulationFailed"));
      } else {
        toast.info(t("txBuilder.simulated", { functionName }));
        if (summary.needsRestore) {
          toast.error(t("txBuilder.restoreRequired"));
        }
      }
    } catch (cause) {
      reportError(describeError(cause));
    } finally {
      setBusy("idle");
    }
  }

  async function handleSubmit() {
    setError(null);
    setOutput(null);
    if (!address) {
      reportError(t("txBuilder.walletRequired"));
      return;
    }
    const checked = validateInputs();
    if (!checked.ok) {
      reportError(checked.error);
      return;
    }
    if (checked.source !== address) {
      reportError(t("txBuilder.sourceMismatch"));
      return;
    }

    setBusy("submit");
    try {
      const server = new rpc.Server(SANDBOX_RPC_URL);
      const account = await server.getAccount(checked.source);
      const tx = buildTransaction({
        spec: CONTRACT_SPEC,
        contractId: checked.contractId,
        source: checked.source,
        functionName,
        values,
        account,
      });
      const simulation = await server.simulateTransaction(tx);
      const summary = summarizeSimulation(simulation);
      if (!summary.ok) {
        setOutput({
          kind: "simulation",
          functionName,
          unsignedXdr: tx.toXDR(),
          simulation: summary,
        });
        reportError(t("txBuilder.simulationFailed"));
        return;
      }

      const ready = rpc.assembleTransaction(tx, simulation).build();
      const signedXdr = await signTransaction(ready.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
      const sent = await server.sendTransaction(signed);
      if (sent.status === "ERROR") {
        throw new Error(
          `Submit failed: ${JSON.stringify(sent.errorResult ?? sent.status)}`,
        );
      }

      let result: rpc.Api.GetTransactionResponse | null = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        result = await server.getTransaction(sent.hash);
        if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) break;
      }
      if (!result || result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        throw new Error(
          `Timed out waiting for transaction ${sent.hash} to be included.`,
        );
      }

      const execution = summarizeExecution(result);
      setOutput({
        kind: "execution",
        functionName,
        unsignedXdr: tx.toXDR(),
        preparedXdr: ready.toXDR(),
        simulation: summary,
        execution,
      });
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        reportError(t("txBuilder.executionFailed"));
      } else {
        toast.success(
          t("txBuilder.executed", { functionName, hash: execution.hash })
        );
      }
    } catch (cause) {
      reportError(describeError(cause));
    } finally {
      setBusy("idle");
    }
  }

  function resetArgs() {
    setValues(defaultArgsForFunction(CONTRACT_SPEC, functionName));
    setOutput(null);
    setError(null);
  }

  return (
    <main className="wrap" style={{ maxWidth: 1100 }}>
      <p>
        <Link href="/" style={{ color: "var(--accent2)", textDecoration: "none" }}>
          ← Back to StreamPay
        </Link>
      </p>

      <div className="kicker mono" style={{ letterSpacing: "0.15em", color: "var(--accent2)" }}>
        SPEC-DRIVEN SOROBAN SANDBOX
      </div>
      <h1>Transaction builder</h1>
      <p className="muted">
        Build any raw StreamPay contract invocation from the canonical spec,
        simulate it against Testnet, inspect the full response, then sign and
        submit it with your wallet. The form is generated from{" "}
        <code>{SPEC_SOURCE}</code> — {SPEC_FUNCTIONS.length} entrypoints.
      </p>

      <div
        className="card"
        style={{
          borderColor: "rgba(245, 158, 11, 0.5)",
          background: "rgba(245, 158, 11, 0.06)",
        }}
      >
        <strong style={{ color: "var(--amber)" }}>Testnet only.</strong>{" "}
        <span className="muted">
          RPC: <code>{SANDBOX_RPC_URL}</code>. A PUBLIC network or mainnet RPC
          configuration is refused before this form renders.
        </span>
      </div>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Invocation</h2>
        <div className="row">
          <div>
            <label htmlFor="txb-contract">Contract ID</label>
            <input
              id="txb-contract"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="C..."
              value={contractId}
              onChange={(event) => setContractId(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="txb-source">Source account</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                id="txb-source"
                type="text"
                spellCheck={false}
                autoComplete="off"
                placeholder="G..."
                value={source}
                onChange={(event) => setSource(event.target.value)}
              />
              {address && (
                <button
                  type="button"
                  className="copy-btn"
                  onClick={() => setSource(address)}
                  title="Use the connected wallet address"
                >
                  Use wallet
                </button>
              )}
            </div>
          </div>
        </div>

        <label htmlFor="txb-function">Entrypoint</label>
        <select
          id="txb-function"
          value={functionName}
          onChange={(event) => selectFunction(event.target.value)}
        >
          {SPEC_FUNCTIONS.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </select>

        {fn?.doc && (
          <p className="muted" style={{ marginBottom: 0 }}>
            {fn.doc.split("\n\n")[0]?.slice(0, 420)}
            {(fn.doc.split("\n\n")[0]?.length ?? 0) > 420 ? "…" : ""}
          </p>
        )}

        <h3>Arguments</h3>
        {fn?.args.length === 0 && <p className="muted">This entrypoint takes no arguments.</p>}
        {fn?.args.map((arg) => (
          <ArgField
            key={arg.name}
            spec={CONTRACT_SPEC}
            type={arg.type}
            value={values[arg.name] ?? null}
            onChange={(next) => updateArg(arg.name, next)}
            label={arg.name}
            path={`${fn.name}.${arg.name}`}
            walletAddress={address}
          />
        ))}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
          <button type="button" onClick={handleSimulate} disabled={busy !== "idle"}>
            {busy === "simulate" ? "Simulating…" : "Simulate"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleSubmit}
            disabled={busy !== "idle" || !address}
            title={
              address
                ? "Sign and submit with the connected wallet"
                : "Connect a wallet to submit"
            }
          >
            {busy === "submit" ? "Submitting…" : "Sign & submit"}
          </button>
          <button type="button" className="btn-secondary" onClick={resetArgs}>
            Reset arguments
          </button>
        </div>
        {!address && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Simulation works without a wallet. Connect Freighter to sign and submit.
          </p>
        )}
      </section>

      <OutputPane output={output} error={error} busy={busy !== "idle"} />
    </main>
  );
}
