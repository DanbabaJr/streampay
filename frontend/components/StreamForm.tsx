"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  NATIVE_XLM,
  tokenContractId,
  fetchAssetMeta,
  type AssetMeta,
  type StreamArgs,
} from "@/lib/stellar";
import { readStreamPolicyAction } from "@/app/actions";
import type { StreamPolicyView } from "@/lib/stream-types";
import { useLocale } from "@/lib/i18n/provider";
import { parseTokenAmount } from "@/lib/i18n/amounts";
import { describeParseFailure } from "@/lib/i18n/parse-error";

/** Asset choices on the create form: native XLM, or a token contract id. */
type AssetChoice = "native" | "contract";

export default function StreamForm({
  onCreate,
}: {
  onCreate: (args: StreamArgs) => Promise<void>;
}) {
  const [asset, setAsset] = useState<AssetChoice>("native");
  const [contractMeta, setContractMeta] = useState<AssetMeta | null>(null);
  const [args, setArgs] = useState<StreamArgs>({
    token: "",
    recipient: "",
    deposit: "1000000000",
    days: "30",
    cancelable: true,
  });
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<StreamPolicyView | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const { t, locale, formatToken } = useLocale();

  // The deposit field is locale-aware text, not `type="number"`: an HTML number
  // input means a German keyboard's comma can never be typed, and a field that
  // accepts it would then silently disagree with what is shown. `args.deposit`
  // holds the *typed* text; the canonical integer is derived, never edited.
  const depositParse = useMemo(
    // Smallest-unit field: 0 decimals, so any fraction must be rejected rather
    // than rounded into a different on-chain amount.
    () => parseTokenAmount(args.deposit, locale, { decimals: 0, allowNegative: false }),
    [args.deposit, locale]
  );
  const depositVal = depositParse.ok ? depositParse.value : 0n;

  // Derived asset metadata: native XLM is always known; contract assets update asynchronously
  const assetMeta: AssetMeta =
    asset === "native"
      ? { code: "XLM", decimals: 7 }
      : contractMeta ?? { code: "TOKEN", decimals: 7 };

  // Load asset meta for contract token choices
  useEffect(() => {
    let active = true;
    if (asset === "contract") {
      const token = args.token.trim();
      if (token) {
        fetchAssetMeta(token).then((meta) => {
          if (active) setContractMeta(meta);
        });
      }
    }
    return () => {
      active = false;
    };
  }, [asset, args.token]);

  // Load policy for selected asset
  useEffect(() => {
    let active = true;
    const token = asset === "native" ? tokenContractId(NATIVE_XLM) : args.token.trim();
    if (token) {
      readStreamPolicyAction(token).then((p) => {
        if (active) setPolicy(p);
      });
    } else {
      readStreamPolicyAction().then((p) => {
        if (active) setPolicy(p);
      });
    }
    return () => {
      active = false;
    };
  }, [asset, args.token]);

  // Stable IDs for ARIA associations (WCAG 1.3.1 / 4.1.2)
  const formId = useId();
  const assetId = `${formId}-asset`;
  const tokenId = `${formId}-token`;
  const tokenHintId = `${formId}-token-hint`;
  const recipientId = `${formId}-recipient`;
  const recipientHintId = `${formId}-recipient-hint`;
  const depositId = `${formId}-deposit`;
  const depositHintId = `${formId}-deposit-hint`;
  const depositErrorId = `${formId}-deposit-error`;
  const daysId = `${formId}-days`;
  const cancelableId = `${formId}-cancelable`;
  const formDescId = `${formId}-desc`;

  const set =
    (k: keyof StreamArgs) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setPolicyError(null);
      setArgs((prev) => ({
        ...prev,
        [k]:
          k === "cancelable"
            ? (e.target as HTMLSelectElement).value === "yes"
            : e.target.value,
      }));
    };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPolicyError(null);

    if (!depositParse.ok) {
      setPolicyError(
        describeParseFailure(t, depositParse.reason, {
          input: args.deposit,
          locale,
          decimals: 0,
        })
      );
      return;
    }

    // Client-side pre-validation against governance policy floors
    if (policy) {
      const depositValParsed = depositParse.value;
      const durationSeconds = Math.floor(Number(args.days || "0") * 86400);

      if (BigInt(policy.minDeposit) > 0n && depositValParsed < BigInt(policy.minDeposit)) {
        setPolicyError(
          t("form.policyDepositLow", {
            min: formatToken(BigInt(policy.minDeposit), assetMeta.decimals),
          })
        );
        return;
      }
      if (policy.minDuration > 0 && durationSeconds < policy.minDuration) {
        setPolicyError(
          t("form.policyDurationLow", { actual: durationSeconds, min: policy.minDuration })
        );
        return;
      }
      if (policy.maxDuration > 0 && durationSeconds > policy.maxDuration) {
        setPolicyError(
          t("form.policyDurationHigh", { actual: durationSeconds, max: policy.maxDuration })
        );
        return;
      }

      const rate = depositValParsed / BigInt(Math.max(1, durationSeconds));
      if (BigInt(policy.minRate) > 0n && rate < BigInt(policy.minRate)) {
        setPolicyError(
          t("form.policyRateLow", {
            rate: formatToken(rate, assetMeta.decimals),
            min: formatToken(BigInt(policy.minRate), assetMeta.decimals),
          })
        );
        return;
      }
      if (BigInt(policy.maxRate) > 0n && rate > BigInt(policy.maxRate)) {
        setPolicyError(
          t("form.policyRateHigh", {
            rate: formatToken(rate, assetMeta.decimals),
            max: formatToken(BigInt(policy.maxRate), assetMeta.decimals),
          })
        );
        return;
      }
    }

    setBusy(true);
    try {
      // Native XLM streams through its Stellar Asset Contract; the contract
      // only ever sees a token contract id either way. The deposit is sent as
      // the parsed integer, so what is signed is what was meant.
      await onCreate({
        ...args,
        deposit: depositParse.value.toString(),
        token: asset === "native" ? NATIVE_XLM : args.token.trim(),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="card"
      onSubmit={submit}
      aria-labelledby={`${formId}-heading`}
      aria-describedby={formDescId}
      noValidate
    >
      <h2 id={`${formId}-heading`}>{t("form.heading")}</h2>

      {/* Invisible form-level description for SR context */}
      <p id={formDescId} className="sr-only">
        {t("form.srDescription")}
      </p>

      <div className="row">
        <div>
          <label htmlFor={assetId}>
            {t("form.asset")} <span aria-hidden="true">*</span>
            <span className="sr-only">({t("form.required")})</span>
          </label>
          <select
            id={assetId}
            value={asset}
            onChange={(e) => setAsset(e.target.value as AssetChoice)}
            required
          >
            <option value="native">{t("form.assetNative")}</option>
            <option value="contract">{t("form.assetContract")}</option>
          </select>
        </div>

        {asset === "contract" && (
          <div>
            <label htmlFor={tokenId}>
              {t("form.tokenLabel")} <span aria-hidden="true">*</span>
              <span className="sr-only">({t("form.required")})</span>
            </label>
            <input
              id={tokenId}
              type="text"
              required
              placeholder={t("form.tokenPlaceholder")}
              value={args.token}
              onChange={set("token")}
              aria-describedby={tokenHintId}
              autoComplete="off"
            />
            <span id={tokenHintId} className="sr-only">
              {t("form.tokenHint")}
            </span>
          </div>
        )}

        <div>
          <label htmlFor={recipientId}>
            {t("form.recipientLabel")} <span aria-hidden="true">*</span>
            <span className="sr-only">({t("form.required")})</span>
          </label>
          <input
            id={recipientId}
            type="text"
            required
            placeholder="G…"
            value={args.recipient}
            onChange={set("recipient")}
            aria-describedby={recipientHintId}
            autoComplete="off"
          />
          <span id={recipientHintId} className="sr-only">
            {t("form.recipientHint")}
          </span>
        </div>
      </div>

      {asset === "native" && (
        <p className="muted mono" style={{ wordBreak: "break-all" }}>
          {t("form.nativeContractNote", { contractId: tokenContractId(NATIVE_XLM) })}
        </p>
      )}

      <div className="row">
        <div>
          <label htmlFor={depositId}>
            {t("form.depositLabel")} <span aria-hidden="true">*</span>
            <span className="sr-only">({t("form.required")})</span>
          </label>
          <input
            id={depositId}
            type="text"
            inputMode="numeric"
            required
            value={args.deposit}
            onChange={set("deposit")}
            aria-describedby={`${depositHintId} ${depositErrorId}`}
            aria-invalid={depositParse.ok ? undefined : true}
          />
          <span id={depositHintId} className="sr-only">
            {t("form.depositHint")}
          </span>
          {/* Always present so `aria-describedby` never points at a missing id. */}
          <span id={depositErrorId} className="sr-only" aria-live="polite">
            {depositParse.ok
              ? ""
              : describeParseFailure(t, depositParse.reason, {
                  input: args.deposit,
                  locale,
                  decimals: 0,
                })}
          </span>
        </div>

        <div>
          <label htmlFor={daysId}>
            {t("form.durationLabel")} <span aria-hidden="true">*</span>
            <span className="sr-only">({t("form.required")})</span>
          </label>
          <input
            id={daysId}
            type="number"
            min="0.001"
            step="any"
            required
            value={args.days}
            onChange={set("days")}
          />
        </div>

        <div>
          <label htmlFor={cancelableId}>{t("form.cancelableLabel")}</label>
          <select
            id={cancelableId}
            value={args.cancelable ? "yes" : "no"}
            onChange={set("cancelable")}
          >
            <option value="yes">{t("form.yes")}</option>
            <option value="no">{t("form.no")}</option>
          </select>
        </div>
      </div>

      {(() => {
        const durationDays = parseFloat(args.days || "0");
        const durationSeconds = Math.floor(durationDays * 86400);
        const flowRatePerSec =
          durationSeconds > 0 ? depositVal / BigInt(durationSeconds) : 0n;
        const flowRatePerDay =
          durationDays > 0
            ? depositVal / BigInt(Math.max(1, Math.round(durationDays)))
            : 0n;

        if (depositVal <= 0n) return null;

        return (
          <div
            className="stream-preview"
            style={{
              background: "rgba(255, 255, 255, 0.02)",
              border: "1px solid var(--line)",
              borderRadius: "8px",
              padding: "12px 16px",
              marginTop: "14px",
              marginBottom: "14px",
            }}
            aria-label={t("form.preview.aria")}
          >
            <div
              style={{
                fontSize: "0.75rem",
                fontWeight: 700,
                color: "var(--accent2)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: "8px",
              }}
            >
              {t("form.preview.title")}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: "12px",
              }}
            >
              <div>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  {t("form.preview.totalDeposit")}
                </div>
                <div className="mono" style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                  {formatToken(depositVal, assetMeta.decimals)} {assetMeta.code}
                </div>
              </div>
              {durationSeconds > 0 && (
                <div>
                  <div className="muted" style={{ fontSize: "0.8rem" }}>
                    {t("form.preview.dailyRate")}
                  </div>
                  <div className="mono" style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                    ~{formatToken(flowRatePerDay, assetMeta.decimals)} {assetMeta.code}
                    {t("form.unitPerDay")}
                  </div>
                </div>
              )}
              {durationSeconds > 0 && (
                <div>
                  <div className="muted" style={{ fontSize: "0.8rem" }}>
                    {t("form.preview.perSecondRate")}
                  </div>
                  <div className="mono" style={{ fontSize: "0.95rem", color: "var(--muted)" }}>
                    ~{formatToken(flowRatePerSec, assetMeta.decimals)} {assetMeta.code}
                    {t("form.unitPerSecond")}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      <p className="muted">
        {t("form.amountsNote", { decimals: assetMeta.decimals, code: assetMeta.code })}
      </p>

      {policy && (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          {t("form.policyHeading")}
          {BigInt(policy.minDeposit) > 0n &&
            ` ${t("form.policyMinDeposit")}: ${formatToken(BigInt(policy.minDeposit), assetMeta.decimals)} ${assetMeta.code}`}
          {policy.minDuration > 0 && ` | ${t("form.policyMinDuration")}: ${policy.minDuration}s`}
          {policy.maxDuration > 0 && ` | ${t("form.policyMaxDuration")}: ${policy.maxDuration}s`}
          {BigInt(policy.minRate) > 0n &&
            ` | ${t("form.policyMinRate")}: ${formatToken(BigInt(policy.minRate), assetMeta.decimals)} ${assetMeta.code}${t("form.unitPerSecond")}`}
          {BigInt(policy.maxRate) > 0n &&
            ` | ${t("form.policyMaxRate")}: ${formatToken(BigInt(policy.maxRate), assetMeta.decimals)} ${assetMeta.code}${t("form.unitPerSecond")}`}
        </p>
      )}

      {policyError && (
        <div role="alert" style={{ color: "#ef4444", marginBottom: "1rem", fontSize: "0.9rem" }}>
          {policyError}
        </div>
      )}

      <button type="submit" disabled={busy}>
        {busy ? t("form.submitting") : t("form.submit")}
      </button>
    </form>
  );
}
