"use client";

import { lazy, Suspense, useState } from "react";
import {
  fetchStreamIdsPageAction,
  readStreamAction,
} from "@/app/actions";
import { describeError } from "@/lib/errors";
import type { StreamArgs, StreamView } from "@/lib/stream-types";
import { loadStreamIds, saveStreamId } from "@/lib/storage";

const StreamForm = lazy(() => import("@/components/StreamForm"));
const StreamList = lazy(() => import("@/components/StreamList"));

function PanelLoading() {
  return <p className="muted">Loading…</p>;
}

const ROLES = ["recipient", "sender"] as const;
const STREAM_READ_BATCH_SIZE = 5;

export default function Dashboard() {
  const [address, setAddress] = useState<string | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [lookupId, setLookupId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);

  async function connect() {
    setError("");
    try {
      const { isConnected, requestAccess } = await import("@stellar/freighter-api");
      const { isConnected: connected, error: connectedError } =
        await isConnected();
      if (connectedError || !connected) {
        setError("Freighter not detected — install the extension and reload.");
        return;
      }
      const { address, error: accessError } = await requestAccess();
      if (accessError || !address) {
        setError(
          `Wallet connection failed: ${
            accessError?.message ?? "no address returned from Freighter."
          }`
        );
        return;
      }
      setAddress(address);
      setStatus(`Connected as ${address.slice(0, 8)}…`);
      const cached = loadStreamIds(address);
      if (cached.length > 0) {
        const views = await Promise.all(
          cached.map((id) => readStreamAction(id).catch(() => null))
        );
        setStreams(
          views.filter((stream): stream is StreamView => stream !== null).reverse()
        );
      }
    } catch (e) {
      setError(`Wallet connection failed: ${String(e)}`);
    }
  }

  async function refresh(id: string) {
    try {
      const stream = await readStreamAction(id);
      setStreams((prev) => [stream, ...prev.filter((item) => item.id !== id)]);
      if (address) saveStreamId(address, id);
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function discover() {
    if (!address) return;
    setError("");
    const offsets: Record<(typeof ROLES)[number], number> = {
      recipient: 0,
      sender: 0,
    };
    const hasMore: Record<(typeof ROLES)[number], boolean> = {
      recipient: true,
      sender: true,
    };
    const discoveredIds = new Set<string>();
    const discovered = new Map<string, StreamView>();

    try {
      while (ROLES.some((role) => hasMore[role])) {
        const roles = ROLES.filter((role) => hasMore[role]);
        const pages = await Promise.all(
          roles.map((role) =>
            fetchStreamIdsPageAction(address, role, offsets[role])
          )
        );
        const ids: string[] = [];
        pages.forEach((page, index) => {
          const role = roles[index];
          offsets[role] += 50;
          hasMore[role] = page.hasMore;
          for (const id of page.ids) {
            if (!discoveredIds.has(id)) {
              discoveredIds.add(id);
              ids.push(id);
            }
          }
        });

        for (let index = 0; index < ids.length; index += STREAM_READ_BATCH_SIZE) {
          const idBatch = ids.slice(index, index + STREAM_READ_BATCH_SIZE);
          const streams = await Promise.all(
            idBatch.map((id) => readStreamAction(id).catch(() => null))
          );
          const batch = streams.filter(
            (stream): stream is StreamView => stream !== null
          );
          for (const stream of batch) {
            discovered.set(stream.id, stream);
            saveStreamId(address, stream.id);
          }
          if (batch.length > 0) {
            setStreams((previous) => {
              const merged = new Map(previous.map((stream) => [stream.id, stream]));
              for (const stream of batch) merged.set(stream.id, stream);
              return [...merged.values()].sort(
                (a, b) => Number(b.id) - Number(a.id)
              );
            });
          }
        }
      }
      setStatus(`Discovered ${discovered.size} stream(s) on-chain.`);
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function fetchStreamById() {
    const id = lookupId.trim();
    if (!id) {
      setError("Enter a stream ID.");
      return;
    }
    setError("");
    setLookupLoading(true);
    try {
      const stream = await readStreamAction(id);
      setStreams((prev) => [stream, ...prev.filter((item) => item.id !== stream.id)]);
      setStatus(`Stream #${stream.id} loaded.`);
      setLookupId("");
    } catch {
      setError("Stream not found. Check the ID and try again.");
    } finally {
      setLookupLoading(false);
    }
  }

  if (!address) {
    return (
      <main className="wrap">
        <div className="kicker mono">SOROBAN · STELLAR</div>
        <h1>⚡ StreamPay</h1>
        <p className="muted">
          Continuous, per-second payment streams — payroll, vesting,
          subscriptions. Connect Freighter to begin.
        </p>
        <button onClick={connect}>Connect Freighter</button>
        {error && <p className="err">{error}</p>}
      </main>
    );
  }

  return (
    <main className="wrap">
      <h1>⚡ StreamPay</h1>
      <p className="muted">
        Connected: <code>{address}</code>
      </p>
      {status && <p className="ok">{status}</p>}
      {error && <p className="err">{error}</p>}

      <Suspense fallback={<PanelLoading />}>
        <StreamForm
          onCreate={async (args: StreamArgs) => {
            setError("");
            try {
              const { createStream } = await import("@/lib/stellar");
              const id = await createStream(address, args);
              setStatus(`Stream #${id} created.`);
              await refresh(String(id));
            } catch (e) {
              setError(String(e));
            }
          }}
        />
      </Suspense>

      <section className="card">
        <h2>Fetch stream by ID</h2>
        <div className="row">
          <input
            type="text"
            inputMode="numeric"
            placeholder="Stream ID"
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void fetchStreamById();
            }}
          />
          <button
            type="button"
            onClick={fetchStreamById}
            disabled={lookupLoading}
          >
            {lookupLoading ? "Fetching..." : "Fetch stream"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Your streams</h2>
        <div className="row">
          <button onClick={discover} title="Scan the on-chain address indexes">
            Discover on-chain
          </button>
        </div>
        <Suspense fallback={<PanelLoading />}>
          <StreamList
            streams={streams}
            onWithdraw={async (id, amount) => {
              try {
                const { withdrawFromStream } = await import("@/lib/stellar");
                await withdrawFromStream(address, id, amount);
                await refresh(id);
              } catch (e) {
                setError(describeError(e));
              }
            }}
            onWithdrawMax={async (id) => {
              try {
                const { withdrawMaxFromStream } = await import("@/lib/stellar");
                const paid = await withdrawMaxFromStream(address, id);
                setStatus(`Claimed ${paid} units from stream #${id}.`);
                await refresh(id);
              } catch (e) {
                setError(describeError(e));
              }
            }}
            onTopUp={async (id, amount) => {
              try {
                const { topUpStream } = await import("@/lib/stellar");
                await topUpStream(address, id, amount);
                await refresh(id);
              } catch (e) {
                setError(describeError(e));
              }
            }}
            onCancel={async (id) => {
              try {
                const { cancelStream } = await import("@/lib/stellar");
                await cancelStream(address, id);
                await refresh(id);
              } catch (e) {
                setError(describeError(e));
              }
            }}
            onRefresh={(id) => refresh(id)}
          />
        </Suspense>
      </section>
    </main>
  );
}