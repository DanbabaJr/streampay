"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getAddress, isConnected } from "@stellar/freighter-api";
import {
  cancelStream,
  describeError,
  readAvailable,
  readStream,
  withdrawFromStream,
  withdrawMaxFromStream,
  type StreamView,
} from "@/lib/stellar";

function fmtUnits(v: bigint): string {
  return v.toString();
}

export default function StreamDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [stream, setStream] = useState<StreamView | null>(null);
  const [available, setAvailable] = useState<bigint | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [address, setAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const [s, a] = await Promise.all([readStream(id), readAvailable(id)]);
      setStream(s);
      setAvailable(a);
      setError("");
    } catch (e) {
      setError(describeError(e));
    }
  }, [id]);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
    const t = setInterval(() => void reload(), 15_000); // live accrual
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    void (async () => {
      try {
        if (await isConnected()) {
          const { address } = await getAddress();
          setAddress(address);
        }
      } catch {
        // Detail view stays read-only without a wallet.
      }
    })();
  }, []);

  if (error && !stream) {
    return (
      <main className="wrap">
        <h1>Stream #{id}</h1>
        <p className="err">{error}</p>
        <Link href="/">← All streams</Link>
      </main>
    );
  }
  if (!stream) {
    return (
      <main className="wrap">
        <h1>Stream #{id}</h1>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const deposit = BigInt(stream.deposit);
  const withdrawn = BigInt(stream.withdrawn);
  const progress =
    deposit > 0n ? Math.min(100, Number((withdrawn * 100n) / deposit)) : 0;
  const isRecipient = address !== null && address === stream.recipient;
  const isSender = address !== null && address === stream.sender;
  const overWithdrawal =
    available !== null && amount !== "" && BigInt(amount || "0") > available;

  async function doWithdraw(max: boolean) {
    if (!address) return;
    setError("");
    setStatus("");
    try {
      if (max) {
        const paid = await withdrawMaxFromStream(address, stream!.id);
        setStatus(`Claimed ${fmtUnits(paid)} units.`);
      } else {
        if (overWithdrawal) {
          setError(
            `Amount exceeds the accrued balance (${available?.toString()} units). Try “Withdraw max”.`
          );
          return;
        }
        await withdrawFromStream(address, stream!.id, amount || "0");
        setStatus("Withdrawal sent.");
      }
      setAmount("");
      await reload();
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function doCancel() {
    if (!address) return;
    setError("");
    try {
      await cancelStream(address, stream!.id);
      setStatus("Stream cancelled.");
      await reload();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <main className="wrap">
      <p className="kicker mono">STREAM #{stream.id}</p>
      <h1>
        {stream.status === "Active"
          ? "⚡ Streaming"
          : stream.status === "Paused"
            ? "⏸ Paused — accrual frozen"
            : `⏹ ${stream.status}`}
      </h1>
      {status && <p className="ok">{status}</p>}
      {error && <p className="err">{error}</p>}

      <section className="card">
        <div className="row">
          <progress value={progress} max={100} style={{ flex: 1 }} />
          <span className="mono">{progress}% withdrawn</span>
        </div>
        <table>
          <tbody>
            <tr>
              <th>Sender</th>
              <td className="mono">{stream.sender}</td>
            </tr>
            <tr>
              <th>Recipient</th>
              <td className="mono">{stream.recipient}</td>
            </tr>
            <tr>
              <th>Token</th>
              <td className="mono">{stream.token}</td>
            </tr>
            <tr>
              <th>Deposit</th>
              <td className="mono">{stream.deposit}</td>
            </tr>
            <tr>
              <th>Withdrawn</th>
              <td className="mono">{stream.withdrawn}</td>
            </tr>
            <tr>
              <th>Available now</th>
              <td className="mono">{available?.toString() ?? "…"}</td>
            </tr>
            <tr>
              <th>Window</th>
              <td className="mono">
                {new Date(stream.startTime * 1000).toISOString()} →{" "}
                {new Date(stream.endTime * 1000).toISOString()}
              </td>
            </tr>
            <tr>
              <th>Cancelable</th>
              <td>{String(stream.cancelable)}</td>
            </tr>
            <tr>
              <th>Status</th>
              <td>{stream.status}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Withdrawals stay available while paused: the frozen accrued balance
          can still be claimed. */}
      {isRecipient &&
        (stream.status === "Active" || stream.status === "Paused") && (
        <section className="card">
          <h2>Withdraw accrued funds</h2>
          <div className="row">
            <input
              type="number"
              min="0"
              placeholder="amount (defaults to available)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button onClick={() => void doWithdraw(false)}>Withdraw</button>
            <button
              onClick={() => void doWithdraw(true)}
              title="withdraw_max: atomic claim of the full accrued balance"
            >
              Withdraw max
            </button>
          </div>
          {overWithdrawal && (
            <p className="err">
              That exceeds the currently accrued {available?.toString()} units —
              the contract would reject it with AmountExceedsAvailable.
            </p>
          )}
        </section>
      )}

      {/* Cancelling a paused stream is allowed: the split uses the frozen
          accrual point. */}
      {(isSender || (isRecipient && stream.cancelable)) &&
        (stream.status === "Active" || stream.status === "Paused") && (
          <section className="card">
            <h2>Cancel stream</h2>
            <p className="muted">
              Pays the recipient everything accrued and refunds the sender the
              rest, atomically. This is irreversible.
            </p>
            <button onClick={() => void doCancel()}>Cancel stream</button>
          </section>
        )}

      <p>
        <Link href="/">← All streams</Link>
      </p>
    </main>
  );
}
