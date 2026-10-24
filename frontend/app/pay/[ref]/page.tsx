"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { isConnected, requestAccess } from "@stellar/freighter-api";
import {
  readPaymentLinkAction,
  PaymentLinkResolution,
} from "@/app/actions";
import { verifyRecipientBinding } from "@/lib/payment-link";
import {
  claimStreamWithReceipt,
  ClaimReceipt,
  NETWORK_LABEL,
  describeError,
} from "@/lib/stellar";
import { computeAccruedAt } from "@/lib/accrual";
import { checkWalletNetwork } from "@/lib/network";
import { useLocale } from "@/lib/i18n/provider";
import { formatDateTime, formatPercent } from "@/lib/i18n/amounts";

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

export default function PaymentLinkPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  const resolvedParams = use(params);
  const ref = resolvedParams.ref;
  const { t, formatAmount, locale } = useLocale();

  const [loading, setLoading] = useState(true);
  const [resolution, setResolution] = useState<PaymentLinkResolution | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [isRecipientMatch, setIsRecipientMatch] = useState<boolean | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ClaimReceipt | null>(null);
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));

  // Ticker for live linear accrual counter
  useEffect(() => {
    const timer = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch stream resolution client-side on mount
  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const res = await readPaymentLinkAction(ref);
        if (active) {
          setResolution(res);
        }
      } catch (err: unknown) {
        if (active) {
          setResolution({
            valid: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [ref]);

  // When wallet address changes or resolution loads, check blinded recipient binding
  useEffect(() => {
    let active = true;
    async function checkBinding() {
      if (!address || !resolution?.decoded) {
        setIsRecipientMatch(null);
        return;
      }
      const match = await verifyRecipientBinding(resolution.decoded, address);
      if (active) {
        setIsRecipientMatch(match);
      }
    }
    checkBinding();
    return () => {
      active = false;
    };
  }, [address, resolution]);

  async function connectWallet() {
    setClaimError(null);
    try {
      const { isConnected: connected, error: connErr } = await isConnected();
      if (connErr || !connected) {
        setClaimError(t("pay.error.noWallet"));
        return;
      }
      const { address: addr, error: accessErr } = await requestAccess();
      if (accessErr || !addr) {
        setClaimError(accessErr?.message ?? t("pay.error.rejected"));
        return;
      }
      setAddress(addr);
      await checkWalletNetwork();
    } catch (e: unknown) {
      setClaimError(String(e));
    }
  }

  async function handleClaim() {
    if (!address) {
      await connectWallet();
      return;
    }

    if (!resolution?.stream || !resolution.decoded) return;

    if (isRecipientMatch === false) {
      setClaimError(t("pay.error.bindingMismatch"));
      return;
    }

    setClaiming(true);
    setClaimError(null);
    try {
      const resultReceipt = await claimStreamWithReceipt(
        address,
        resolution.decoded.streamId
      );
      setReceipt(resultReceipt);
    } catch (err: unknown) {
      setClaimError(describeError(err));
    } finally {
      setClaiming(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
          <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <h1 className="text-xl font-bold tracking-tight mb-2">{t("pay.loading.title")}</h1>
          <p className="text-sm text-neutral-400">{t("pay.loading.body")}</p>
        </div>
      </main>
    );
  }

  if (!resolution?.valid || !resolution.stream) {
    return (
      <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-4">
        <div className="bg-neutral-900 border border-red-500/30 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
          <div className="w-12 h-12 bg-red-500/10 text-red-400 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl font-bold">
            ✕
          </div>
          <h1 className="text-xl font-bold text-red-300 mb-2">{t("pay.invalid.title")}</h1>
          <p className="text-sm text-neutral-400 mb-6">
            {resolution?.error || t("pay.invalid.body")}
          </p>
          <Link
            href="/"
            className="inline-block px-5 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-xl text-sm font-medium transition"
          >
            {t("chrome.backToDashboard")}
          </Link>
        </div>
      </main>
    );
  }

  const stream = resolution.stream;
  const isCancelled = stream.status.toLowerCase() === "cancelled";
  const isDepleted = stream.status.toLowerCase() === "depleted";
  const hasEnded = nowSec >= stream.endTime;

  // Live real-time accrued calculation
  const totalDepositBig = BigInt(stream.deposit);
  const withdrawnBig = BigInt(stream.withdrawn);
  const accruedNowBig = computeAccruedAt(
    totalDepositBig,
    stream.startTime,
    stream.endTime,
    BigInt(nowSec)
  );
  const claimableNowBig = isCancelled || isDepleted
    ? 0n
    : (accruedNowBig > withdrawnBig ? accruedNowBig - withdrawnBig : 0n);

  const durationTotal = Math.max(1, stream.endTime - stream.startTime);
  const elapsedSec = Math.max(0, Math.min(nowSec - stream.startTime, durationTotal));
  const progressPercent = Math.min(100, Math.round((elapsedSec / durationTotal) * 100));

  // Receipt View
  if (receipt) {
    const explorerUrl = `https://stellar.expert/explorer/${NETWORK_LABEL}/tx/${receipt.txHash}`;
    return (
      <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-4">
        <div className="bg-neutral-900 border border-emerald-500/30 rounded-2xl p-8 max-w-lg w-full shadow-2xl text-center">
          <div className="w-16 h-16 bg-emerald-500/10 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
            ✓
          </div>
          <h1 className="text-2xl font-bold text-emerald-300 mb-2">{t("pay.receipt.title")}</h1>
          <p className="text-sm text-neutral-400 mb-6">{t("pay.receipt.body")}</p>

          <div className="bg-neutral-950/70 border border-neutral-800 rounded-xl p-5 mb-6 text-left space-y-3">
            <div className="flex justify-between items-center text-sm">
              <span className="text-neutral-400">{t("pay.terminal.streamId")}</span>
              <span className="font-mono font-medium text-neutral-200">#{receipt.streamId}</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-neutral-400">{t("pay.receipt.claimedAmount")}</span>
              <span className="font-mono font-bold text-emerald-400">
                {formatAmount(receipt.amount)} {t("pay.invoice.unit.tokens")}
              </span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-neutral-400">{t("pay.receipt.recipientWallet")}</span>
              <span className="font-mono text-neutral-300">{shortenAddress(address || "")}</span>
            </div>
            <div className="border-t border-neutral-800/80 pt-3 flex flex-col gap-1 text-sm">
              <span className="text-neutral-400">{t("pay.receipt.txHash")}</span>
              <span className="font-mono text-xs text-neutral-400 break-all">{receipt.txHash}</span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-semibold transition text-center shadow-lg shadow-emerald-900/30"
            >
              {t("pay.receipt.explorer")}
            </a>
            <Link
              href="/"
              className="px-4 py-3 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-xl text-sm font-medium transition text-center"
            >
              {t("chrome.dashboard")}
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // Dead state terminal cards
  if (isCancelled || isDepleted || (hasEnded && claimableNowBig === 0n)) {
    return (
      <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
          <div className="w-12 h-12 bg-neutral-800 text-neutral-400 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl font-bold">
            !
          </div>
          <h1 className="text-xl font-bold mb-2">
            {isCancelled
              ? t("pay.terminal.cancelledTitle")
              : isDepleted
              ? t("pay.terminal.depletedTitle")
              : t("pay.terminal.completedTitle")}
          </h1>
          <p className="text-sm text-neutral-400 mb-6">
            {isCancelled
              ? t("pay.terminal.cancelledBody")
              : isDepleted
              ? t("pay.terminal.depletedBody")
              : t("pay.terminal.completedBody")}
          </p>

          <div className="bg-neutral-950 border border-neutral-800/80 rounded-xl p-4 mb-6 text-left text-xs space-y-2 font-mono">
            <div className="flex justify-between">
              <span className="text-neutral-500">{t("pay.terminal.streamId")}</span>
              <span className="text-neutral-300">#{stream.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">{t("pay.terminal.totalFunded")}</span>
              <span className="text-neutral-300">{formatAmount(stream.deposit)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">{t("pay.terminal.totalWithdrawn")}</span>
              <span className="text-neutral-300">{formatAmount(stream.withdrawn)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">{t("pay.terminal.status")}</span>
              <span className="capitalize text-amber-400">{stream.status}</span>
            </div>
          </div>

          <Link
            href="/"
            className="inline-block px-5 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-xl text-sm font-medium transition"
          >
            {t("chrome.goToAppHome")}
          </Link>
        </div>
      </main>
    );
  }

  // Active Stream Claim Surface
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col justify-between p-4 sm:p-8">
      <header className="max-w-2xl mx-auto w-full flex justify-between items-center py-4 border-b border-neutral-800/60 mb-8">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
            S
          </div>
          <span className="font-bold tracking-tight text-lg text-white">{t("brand.name")}</span>
        </Link>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
            {t("chrome.networkLive", { network: NETWORK_LABEL })}
          </span>
        </div>
      </header>

      <div className="max-w-xl mx-auto w-full my-auto">
        <div className="bg-neutral-900 border border-neutral-800 rounded-3xl p-6 sm:p-8 shadow-2xl relative overflow-hidden backdrop-blur-xl">
          <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none" />

          {/* Header */}
          <div className="flex justify-between items-start mb-6">
            <div>
              <span className="text-xs uppercase tracking-wider font-semibold text-indigo-400">
                {t("pay.invoice.kicker")}
              </span>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-white mt-1">
                {t("pay.invoice.title", { id: stream.id })}
              </h1>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
              {t("pay.invoice.active")}
            </span>
          </div>

          {/* Accrued / Available Box */}
          <div className="bg-gradient-to-br from-indigo-950/40 via-neutral-900 to-neutral-950 border border-indigo-500/20 rounded-2xl p-6 mb-6 text-center shadow-inner">
            <span className="text-xs font-medium text-indigo-300 uppercase tracking-wide">
              {t("pay.invoice.availableLabel")}
            </span>
            <div className="text-3xl sm:text-4xl font-extrabold text-white font-mono my-2 tracking-tight">
              {formatAmount(claimableNowBig)}{" "}
              <span className="text-sm font-sans font-medium text-neutral-400">{t("pay.invoice.unit.tokens")}</span>
            </div>
            <div className="text-xs text-neutral-400 flex items-center justify-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              {t("pay.invoice.streaming")}
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mb-6">
            <div className="flex justify-between text-xs text-neutral-400 mb-2">
              <span>{t("pay.invoice.progress", { percent: formatPercent(progressPercent, locale) })}</span>
              <span>
                {t("pay.invoice.total", { amount: formatAmount(stream.deposit), unit: "tokens" })}
              </span>
            </div>
            <div className="w-full bg-neutral-800 h-2.5 rounded-full overflow-hidden">
              <div
                className="bg-gradient-to-r from-indigo-500 to-purple-500 h-full transition-all duration-1000 ease-linear rounded-full"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* Details Table */}
          <div className="bg-neutral-950/60 border border-neutral-800/80 rounded-2xl p-4 sm:p-5 mb-6 space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-neutral-400 text-xs sm:text-sm">{t("pay.invoice.payer")}</span>
              <span className="font-mono text-xs sm:text-sm text-neutral-200">
                {shortenAddress(stream.sender)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-neutral-400 text-xs sm:text-sm">{t("pay.invoice.payee")}</span>
              <span className="inline-flex items-center gap-1.5 text-xs text-indigo-300 bg-indigo-500/10 px-2.5 py-1 rounded-lg border border-indigo-500/20">
                {t("pay.invoice.payeeProtected")}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-neutral-400 text-xs sm:text-sm">{t("pay.invoice.token")}</span>
              <span className="font-mono text-xs text-neutral-400">
                {shortenAddress(stream.token)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-neutral-400 text-xs sm:text-sm">{t("pay.invoice.alreadyClaimed")}</span>
              <span className="font-mono text-xs sm:text-sm text-neutral-300">
                {formatAmount(stream.withdrawn)} {t("pay.invoice.unit.tokens")}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-neutral-400 text-xs sm:text-sm">{t("pay.invoice.endTime")}</span>
              <span className="text-xs text-neutral-400">
                {formatDateTime(stream.endTime, locale)}
              </span>
            </div>
          </div>

          {/* Wallet and Verification Status */}
          {address && (
            <div className="mb-6 p-4 rounded-xl border text-xs flex items-center justify-between gap-3 bg-neutral-950/80 border-neutral-800">
              <div>
                <span className="text-neutral-400 block mb-0.5">{t("pay.wallet.connected")}</span>
                <span className="font-mono text-neutral-200 font-medium">{shortenAddress(address)}</span>
              </div>
              {isRecipientMatch === true && (
                <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold flex items-center gap-1">
                  {t("pay.wallet.verified")}
                </span>
              )}
              {isRecipientMatch === false && (
                <span className="px-2.5 py-1 rounded-full bg-red-500/10 text-red-400 border border-red-500/20 font-semibold flex items-center gap-1">
                  {t("pay.wallet.mismatch")}
                </span>
              )}
            </div>
          )}

          {/* Error Alert */}
          {claimError && (
            <div
              role="alert"
              className="p-4 mb-6 rounded-xl bg-red-950/40 border border-red-500/40 text-red-300 text-xs space-y-1"
            >
              <div className="font-semibold flex items-center gap-1.5">
                <span>⚠️</span> {t("pay.error.heading")}
              </div>
              <p>{claimError}</p>
            </div>
          )}

          {/* Action Button */}
          {!address ? (
            <button
              type="button"
              id="connect-claim-button"
              onClick={connectWallet}
              className="w-full py-4 px-6 rounded-2xl font-bold text-white bg-gradient-to-r from-indigo-600 via-indigo-500 to-purple-600 hover:from-indigo-500 hover:to-purple-500 transition shadow-lg shadow-indigo-600/30 flex items-center justify-center gap-2 text-base"
            >
              {t("pay.action.connectAndClaim")}
            </button>
          ) : (
            <button
              type="button"
              id="claim-now-button"
              disabled={claiming || isRecipientMatch === false || claimableNowBig === 0n}
              onClick={handleClaim}
              className={`w-full py-4 px-6 rounded-2xl font-bold text-white transition shadow-lg flex items-center justify-center gap-2 text-base ${
                isRecipientMatch === false || claimableNowBig === 0n
                  ? "bg-neutral-800 text-neutral-500 cursor-not-allowed shadow-none"
                  : claiming
                  ? "bg-indigo-700 cursor-wait shadow-indigo-700/30"
                  : "bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-emerald-600/30"
              }`}
            >
              {claiming ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  {t("pay.action.claiming")}
                </>
              ) : isRecipientMatch === false ? (
                t("pay.action.switchAccount")
              ) : claimableNowBig === 0n ? (
                t("pay.action.nothingToClaim")
              ) : (
                t("pay.action.claim", { amount: formatAmount(claimableNowBig) })
              )}
            </button>
          )}

          <p className="text-center text-neutral-500 text-xs mt-4">
            {t("pay.note")}
          </p>
        </div>
      </div>

      <footer className="max-w-2xl mx-auto w-full text-center py-6 text-xs text-neutral-500 border-t border-neutral-900 mt-8">
        {t("brand.footer")}
      </footer>
    </main>
  );
}
