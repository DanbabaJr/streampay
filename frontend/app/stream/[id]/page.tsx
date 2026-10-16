"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getAddress, isConnected } from "@stellar/freighter-api";
import {
  attachMetadata,
  cancelStream,
  describeError,
  readAttestations,
  isNativeXlm,
  readAvailable,
  readStream,
  withdrawFromStream,
  withdrawMaxFromStream,
  type AttestationView,
  type StreamView,
} from "@/lib/stellar";
import { computeAvailable, StreamSnapshot } from "@/lib/accrual";
import { useToast } from "@/components/toast";

function fmtUnits(v: bigint): string {
  return v.toString();
}

export default function StreamDetail() {
  const toast = useToast();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [stream, setStream] = useState<StreamView | null>(null);
  const [available, setAvailable] = useState<bigint | null>(null);
  const [attestations, setAttestations] = useState<AttestationView[]>([]);
  const [hashInput, setHashInput] = useState<string>("");
  const [tagInput, setTagInput] = useState<string>("");
  const [displayAvailable, setDisplayAvailable] = useState<bigint | null>(
    null
  );
  const [snapshot, setSnapshot] = useState<StreamSnapshot | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [address, setAddress] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string>("");

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const [s, a, att] = await Promise.all([
        readStream(id),
        readAvailable(id),
        readAttestations(id),
      ]);
      setStream(s);
      setAvailable(a);
      setAttestations(att);
      setSnapshot({
        deposit: BigInt(s.deposit),
        startTime: s.startTime,
        endTime: s.endTime,
        withdrawn: BigInt(s.withdrawn),
        status: s.status,
      });
      setLoadError("");
    } catch (e) {
      const msg = describeError(e);
      setLoadError(msg);
      toast.error(msg);
    }
  }, [id, toast]);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
    const t = setInterval(() => void reload(), 15_000); // live accrual
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    if (!snapshot) return;
    const timer = setInterval(() => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const next = computeAvailable(
        snapshot.deposit,
        snapshot.startTime,
        snapshot.endTime,
        snapshot.withdrawn,
        snapshot.status,
        now
      );
      setDisplayAvailable(next);
    }, 1000);
    return () => clearInterval(timer);
  }, [snapshot]);

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

  if (loadError && !stream) {
    return (
      <main className="wrap">
        <h1>Stream #{id}</h1>
        <p className="err">{loadError}</p>
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
    try {
      if (max) {
        const paid = await withdrawMaxFromStream(address, stream!.id);
        toast.success(`Claimed ${fmtUnits(paid)} units.`);
      } else {
        if (overWithdrawal) {
          toast.error(
            `Amount exceeds the accrued balance (${available?.toString()} units). Try “Withdraw max”.`
          );
          return;
        }
        await withdrawFromStream(address, stream!.id, amount || "0");
        toast.success("Withdrawal sent.");
      }
      setAmount("");
      await reload();
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function doCancel() {
    if (!address) return;
    try {
      await cancelStream(address, stream!.id);
      toast.success("Stream cancelled.");
      await reload();
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function doAttach() {
    if (!address) return;
    try {
      const index = await attachMetadata(
        address,
        stream!.id,
        hashInput,
        tagInput
      );
      toast.success(`Attestation #${index} recorded on-chain.`);
      setHashInput("");
      setTagInput("");
      await reload();
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  return (
    <main className="wrap">
      <p className="kicker mono">STREAM #{stream.id}</p>
      <h1>
        {stream.status === "Active" ? "⚡ Streaming" : `⏹ ${stream.status}`}
      </h1>

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
              <td className="mono" style={{ wordBreak: "break-all" }}>
                {isNativeXlm(stream.token)
                  ? `Native XLM — ${stream.token}`
                  : stream.token}
              </td>
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
              <td className="mono">
                {snapshot?.status === "Active"
                  ? (displayAvailable ?? available)?.toString() ?? "…"
                  : available?.toString() ?? "…"}
              </td>
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

      {isRecipient && stream.status === "Active" && (
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

      {(isSender || (isRecipient && stream.cancelable)) &&
        stream.status === "Active" && (
          <section className="card">
            <h2>Cancel stream</h2>
            <p className="muted">
              Pays the recipient everything accrued and refunds the sender the
              rest, atomically. This is irreversible.
            </p>
            <button onClick={() => void doCancel()}>Cancel stream</button>
          </section>
        )}

      <section className="card">
        <h2>Metadata attestations</h2>
        <p className="muted">
          Hash-linked claims attached by either party — e.g. the SHA-256 of an
          invoice this stream pays. The contract records who claimed which hash
          and when; it never stores the document. Verify a document against a
          hash with <code>scripts/verify_attestation.sh</code>.
        </p>
        {attestations.length === 0 ? (
          <p className="muted">No attestations recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Attester</th>
                <th>Tag</th>
                <th>Content hash (SHA-256)</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {attestations.map((a) => (
                <tr key={a.index}>
                  <td className="mono">{a.index}</td>
                  <td className="mono">
                    {a.attester === stream.sender
                      ? "sender "
                      : a.attester === stream.recipient
                        ? "recipient "
                        : ""}
                    {a.attester.slice(0, 8)}…
                  </td>
                  <td>{a.tag || "—"}</td>
                  <td className="mono" title={a.contentHash}>
                    {a.contentHash.slice(0, 16)}…
                  </td>
                  <td className="mono">
                    {new Date(a.timestamp * 1000).toISOString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {(isSender || isRecipient) && (
        <section className="card">
          <h2>Attach metadata</h2>
          <p className="muted">
            Attach a 32-byte content hash (64 hex characters) and a short tag,
            e.g. for an invoice PDF. Attestations are append-only: attaching
            again never overwrites an earlier entry.
          </p>
          <label htmlFor="hash">Content hash (SHA-256, hex)</label>
          <input
            id="hash"
            type="text"
            placeholder="64 hex characters"
            value={hashInput}
            onChange={(e) => setHashInput(e.target.value)}
          />
          <label htmlFor="tag">Tag (at most 32 bytes)</label>
          <input
            id="tag"
            type="text"
            maxLength={32}
            placeholder="invoice-0042"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
          />
          <button onClick={() => void doAttach()}>Attach attestation</button>
        </section>
      )}

      <p>
        <Link href="/">← All streams</Link>
      </p>
    </main>
  );
}
