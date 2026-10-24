"use client";

import { useState } from "react";
import Link from "next/link";
import { isConnected, requestAccess } from "@stellar/freighter-api";
import {
  createStream,
  createStreams,
  withdrawFromStream,
  withdrawMaxFromStream,
  topUpStream,
  cancelStream,
  readStream,
  fetchStreamsFor,
  fetchAssetMeta,
  describeError,
  type StreamView,
} from "@/lib/stellar";
import { loadStreamIds, saveStreamId } from "@/lib/storage";
import { checkWalletNetwork } from "@/lib/network";
import { useLocale } from "@/lib/i18n/provider";
import StreamForm from "@/components/StreamForm";
import BatchStreamForm from "@/components/BatchStreamForm";
import StreamList from "@/components/StreamList";
import { useToast } from "@/components/toast";

export default function Home() {
  const toast = useToast();
  const { t, formatToken } = useLocale();
  const [address, setAddress] = useState<string | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [lookupId, setLookupId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);

  async function connect() {
    try {
      const { isConnected: connected, error: connectedError } =
        await isConnected();
      if (connectedError || !connected) {
        toast.error(t("home.walletMissing"));
        return;
      }
      const { address, error: accessError } = await requestAccess();
      if (accessError || !address) {
        toast.error(
          t("home.walletFailed", {
            reason: accessError?.message ?? t("home.walletNoAddress"),
          })
        );
        return;
      }
      setAddress(address);
      toast.success(t("home.connectedAs", { address: `${address.slice(0, 8)}…` }));
      // Surface a wallet/app network mismatch here instead of letting it
      // arrive later as an opaque signing error (issue #33).
      await checkWalletNetwork();
      // Rehydrate the cached list (ids only; state is always read fresh).
      const cached = loadStreamIds(address);
      if (cached.length > 0) {
        const views = await Promise.all(
          cached.map((id) => readStream(id).catch(() => null))
        );
        setStreams(
          views.filter((s): s is StreamView => s !== null).reverse()
        );
      }
    } catch (e) {
      toast.error(t("home.walletFailed", { reason: String(e) }));
    }
  }

  async function refresh(id: string) {
    try {
      const s = await readStream(id);
      setStreams((prev) => [s, ...prev.filter((x) => x.id !== id)]);
      if (address) saveStreamId(address, id);
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function discover() {
    if (!address) return;
    try {
      const [asRecipient, asSender] = await Promise.all([
        fetchStreamsFor(address, "recipient"),
        fetchStreamsFor(address, "sender"),
      ]);
      const byId = new Map<string, StreamView>();
      for (const s of [...asRecipient, ...asSender]) byId.set(s.id, s);
      const found = [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));
      setStreams(found);
      toast.info(t("home.discovered", { count: found.length }));
      for (const s of found) saveStreamId(address, s.id);
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function fetchStreamById() {
    const id = lookupId.trim();

    if (!id) {
      toast.error(t("home.enterStreamId"));
      return;
    }

    setLookupLoading(true);

    try {
      const stream = await readStream(id);
      setStreams((prev) => [stream, ...prev.filter((x) => x.id !== stream.id)]);
      toast.success(t("home.streamLoaded", { id: stream.id }));
      setLookupId("");
    } catch {
      toast.error(t("home.streamNotFound"));
    } finally {
      setLookupLoading(false);
    }
  }

  if (!address) {
    return (
      <main className="wrap">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
          <div>
            <div className="kicker mono">{t("home.kicker")}</div>
            <h1>{t("home.title")}</h1>
          </div>
          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <Link href="/docs" style={{ color: "#38bdf8", fontSize: "0.85rem", textDecoration: "none" }}>
              {t("chrome.apiDocs")}
            </Link>
            <Link href="/listings" style={{ color: "var(--accent2)", fontSize: "14px", textDecoration: "none" }}>
              {t("home.browse")}
            </Link>
          </div>
        </div>
        <p className="muted">{t("home.tagline")}</p>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <button onClick={connect}>{t("home.connect")}</button>
          <a
            href="/simulator"
            style={{
              display: "inline-block",
              marginTop: "14px",
              padding: "10px 18px",
              background: "#161f30",
              border: "1px solid var(--line)",
              borderRadius: "8px",
              color: "var(--accent2)",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: "14px",
            }}
          >
            {t("chrome.simulatorLink")}
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="wrap">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
        <h1>{t("home.title")}</h1>
        <div style={{ display: "flex", gap: "16px", alignItems: "baseline" }}>
          <a
            href="/simulator"
            style={{
              color: "var(--accent2)",
              textDecoration: "none",
              fontSize: "13px",
              fontWeight: 600,
            }}
          >
            {t("chrome.simulatorLink")}
          </a>
          <Link href="/listings" style={{ color: "var(--accent2)", fontSize: "14px", textDecoration: "none" }}>
            {t("home.browse")}
          </Link>
        </div>
      </div>
      <p className="muted">
        {t("home.connectedLabel")} <code>{address}</code>
      </p>

      <StreamForm
        onCreate={async (args) => {
          try {
            const id = await createStream(address, args);
            toast.success(t("home.created", { id }));
            await refresh(String(id));
          } catch (e) {
            toast.error(describeError(e));
          }
        }}
      />

      <BatchStreamForm
        onCreate={async (token, entries, cancelable) => {
          try {
            const ids = await createStreams(address, token, entries, cancelable);
            toast.success(
              t("home.batchCreated", {
                count: ids.length,
                ids: ids.map((id) => `#${id}`).join(", "),
              })
            );
            await Promise.all(ids.map((id) => refresh(String(id))));
            return true;
          } catch (e) {
            toast.error(describeError(e));
            return false;
          }
        }}
      />

      <section className="card">
        <h2>{t("home.fetchById")}</h2>

        <div className="row">
          <input
            type="text"
            inputMode="numeric"
            placeholder={t("home.streamIdPlaceholder")}
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void fetchStreamById();
              }
            }}
          />

          <button
            type="button"
            onClick={fetchStreamById}
            disabled={lookupLoading}
          >
            {lookupLoading ? t("home.fetching") : t("home.fetch")}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>{t("home.yourStreams")}</h2>
        <div className="row">
          <button onClick={discover} title={t("home.discoverOnchain")}>
            {t("home.discoverOnchain")}
          </button>
        </div>
        <StreamList
          streams={streams}
          onWithdraw={async (id, amount) => {
            try {
              await withdrawFromStream(address, id, amount);
              const target = streams.find((s) => s.id === id);
              let amountLabel = `${amount} ${t("home.unitsWord")}`;
              if (target) {
                const meta = await fetchAssetMeta(target.token);
                amountLabel = `${formatToken(BigInt(amount), meta.decimals)} ${meta.code}`;
              }
              toast.success(t("home.withdrew", { amount: amountLabel, id }));
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onWithdrawMax={async (id) => {
            try {
              const paid = await withdrawMaxFromStream(address, id);
              const target = streams.find((s) => s.id === id);
              let paidLabel = `${paid} ${t("home.unitsWord")}`;
              if (target) {
                const meta = await fetchAssetMeta(target.token);
                paidLabel = `${formatToken(paid, meta.decimals)} ${meta.code}`;
              }
              toast.success(t("home.claimed", { amount: paidLabel, id }));
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onTopUp={async (id, amount) => {
            try {
              await topUpStream(address, id, amount);
              const target = streams.find((s) => s.id === id);
              let amountLabel = `${amount} ${t("home.unitsWord")}`;
              if (target) {
                const meta = await fetchAssetMeta(target.token);
                amountLabel = `${formatToken(BigInt(amount), meta.decimals)} ${meta.code}`;
              }
              toast.success(t("home.toppedUp", { amount: amountLabel, id }));
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onCancel={async (id) => {
            try {
              await cancelStream(address, id);
              toast.success(t("home.cancelled", { id }));
              await refresh(id);
            } catch (e) {
              toast.error(describeError(e));
            }
          }}
          onRefresh={(id) => refresh(id)}
        />
      </section>
    </main>
  );
}