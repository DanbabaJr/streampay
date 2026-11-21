/**
 * Field-level validation for the stream creation forms (`StreamForm` and
 * `BatchStreamForm`).
 *
 * The forms used to submit whatever was typed and surface the failure as one
 * form-level message — or not at all until the contract rejected the call.
 * Every rule here is checked before submit, against the field the user can
 * fix, and a contract/API rejection after submit is mapped back to that same
 * field (`mapCreationErrorToField`).
 *
 * Bounds come from shared sources, never literals in this file:
 *
 * - Governance policy floors/ceilings (`minDeposit`, `minDuration`,
 *   `maxDuration`, `minRate`, `maxRate`) arrive at runtime from
 *   `readStreamPolicyAction` as a `StreamPolicyView` — the same shape the
 *   contract enforces in `contracts/streaming-payments/src/policy.rs`
 *   (`validate_stream_args`) and the SDK exposes as `StreamPolicy`.
 * - The protocol ceilings are the contract's, via `lib/protocol-limits.ts`
 *   (single frontend source of truth, kept equal to
 *   `sdks/spec/streampay.spec.json` by the client-parity suite):
 *   `MAX_DURATION_SECONDS` is the 100-year cap `create_stream` enforces
 *   (`DurationTooLong`, #8), and `MAX_BATCH`/`MIN_BATCH` are the
 *   `create_streams_batch` limits (`BatchEmpty` #47 / `BatchTooLarge` #48).
 * - The deposit/duration capacity rule mirrors
 *   `stream::validate_capacity`: `deposit * duration` must fit in a `u128`,
 *   so `deposit` may not exceed `u128::MAX / duration`.
 * - The deposit-sufficiency rule is the rate the contract derives,
 *   `rate = deposit / duration`: a stream whose rate floors to zero
 *   smallest units per second never accrues, so the deposit must fund at
 *   least one smallest unit per second (`deposit >= duration` seconds).
 * - Address validity is the Stellar checksum (`StrKey`), not a prefix or
 *   length check: a mistyped `G…`/`C…` address must fail here, not at the
 *   signing step.
 *
 * This module is pure (no React, no I/O) so the rules are unit-testable;
 * components only render what it returns. Messages are already localized:
 * callers pass the locale-bound formatter `t`, following
 * `describeParseFailure` in `lib/i18n/parse-error.ts`.
 */

import { StrKey } from "@stellar/stellar-sdk";

import { parseBatchCsv, type BatchStreamEntry } from "./batch.ts";
import { durationSecondsFromDays } from "./duration.ts";
import { describeError, getErrorDetails } from "./errors.ts";
import { parseTokenAmount } from "./i18n/amounts.ts";
import type { Formatter } from "./i18n/format.ts";
import type { Locale } from "./i18n/locales.ts";
import { describeParseFailure } from "./i18n/parse-error.ts";
import {
  MAX_BATCH,
  MAX_DURATION_SECONDS,
  MIN_BATCH,
} from "./protocol-limits.ts";
import type { StreamPolicyView } from "./stream-types.ts";

/** Fields of the single-stream form. */
export type StreamFormField = "token" | "recipient" | "deposit" | "duration";
/** Fields of the batch form. */
export type BatchFormField = "token" | "csv";
export type FormField = StreamFormField | BatchFormField;

/** One localized message attached to the field that can fix it. */
export interface FieldIssue {
  field: FormField;
  message: string;
}

/** A contract/API rejection mapped back to a field, or to the form. */
export interface MappedRejection {
  /** `null` when no field can fix the rejection (form-level message). */
  field: FormField | null;
  message: string;
}

/** Largest unsigned 128-bit integer; the contract's `validate_capacity` bound. */
const U128_MAX = (1n << 128n) - 1n;

export interface StreamFormValues {
  asset: "native" | "contract";
  token: string;
  recipient: string;
  /** Typed text, in smallest token units. */
  deposit: string;
  /** Typed text, in days. */
  days: string;
}

export interface ValidationOptions {
  locale: Locale;
  t: Formatter;
  /** Governance policy for the selected asset, once loaded (`null` while loading). */
  policy: StreamPolicyView | null;
  /** Token decimals, for formatting amounts inside messages. */
  decimals: number;
  /** Locale-aware smallest-unit formatting, from `useLocale().formatToken`. */
  formatToken: (raw: bigint, decimals: number) => string;
}

/** Empty or checksum-invalid recipient address, else `null`. */
export function validateRecipientAddress(value: string, t: Formatter): string | null {
  const trimmed = value.trim();
  if (!trimmed) return t("form.recipientRequired");
  if (!StrKey.isValidEd25519PublicKey(trimmed)) return t("form.recipientInvalid");
  return null;
}

/** Empty or checksum-invalid token contract id, else `null`. */
export function validateTokenContractId(value: string, t: Formatter): string | null {
  const trimmed = value.trim();
  if (!trimmed) return t("form.tokenRequired");
  if (!StrKey.isValidContract(trimmed)) return t("form.tokenInvalid");
  return null;
}

/**
 * Duration in seconds for a `days` input, or the duration issue.
 * `durationSecondsFromDays` is the shared days→seconds conversion (the same
 * one the operation builder uses), so its 36,500-day cap and its rejection
 * of non-positive input apply here too.
 */
export function durationSeconds(
  days: string,
  policy: StreamPolicyView | null,
  t: Formatter
): { seconds: bigint | null; issue: FieldIssue | null } {
  let seconds: bigint;
  try {
    seconds = durationSecondsFromDays(days);
  } catch {
    return { seconds: null, issue: { field: "duration", message: t("form.durationInvalid") } };
  }
  if (seconds > BigInt(MAX_DURATION_SECONDS)) {
    return {
      seconds,
      issue: {
        field: "duration",
        message: t("form.durationTooLong", { max: MAX_DURATION_SECONDS }),
      },
    };
  }
  if (policy) {
    const actual = Number(seconds);
    if (policy.minDuration > 0 && seconds < BigInt(policy.minDuration)) {
      return {
        seconds,
        issue: {
          field: "duration",
          message: t("form.policyDurationLow", { actual, min: policy.minDuration }),
        },
      };
    }
    if (policy.maxDuration > 0 && seconds > BigInt(policy.maxDuration)) {
      return {
        seconds,
        issue: {
          field: "duration",
          message: t("form.policyDurationHigh", { actual, max: policy.maxDuration }),
        },
      };
    }
  }
  return { seconds, issue: null };
}

/**
 * Deposit rules: locale-aware smallest-unit parsing (fractions are refused,
 * not rounded — see `parseTokenAmount`), positivity, the policy deposit
 * floor, sufficiency for the chosen duration (rate >= 1 smallest unit/s),
 * the `u128` capacity bound, and the policy rate bounds.
 *
 * Rate issues attach to the deposit field: the rate is `deposit / duration`,
 * and raising (or lowering) the deposit is the fix the message names. The
 * duration field keeps the duration bounds, which are its own.
 */
export function validateDeposit(
  depositText: string,
  durationSeconds: bigint | null,
  options: ValidationOptions
): FieldIssue | null {
  const { locale, t, policy, decimals, formatToken } = options;
  const parsed = parseTokenAmount(depositText, locale, {
    decimals: 0,
    allowNegative: false,
  });
  if (!parsed.ok) {
    return {
      field: "deposit",
      message: describeParseFailure(t, parsed.reason, {
        input: depositText,
        locale,
        decimals: 0,
      }),
    };
  }
  const deposit = parsed.value;
  if (deposit <= 0n) {
    return { field: "deposit", message: t("form.amountNegative") };
  }
  if (policy && BigInt(policy.minDeposit) > 0n && deposit < BigInt(policy.minDeposit)) {
    return {
      field: "deposit",
      message: t("form.policyDepositLow", {
        min: formatToken(BigInt(policy.minDeposit), decimals),
      }),
    };
  }
  if (durationSeconds !== null) {
    if (deposit < durationSeconds) {
      return {
        field: "deposit",
        message: t("form.depositTooSmallForDuration", {
          min: formatToken(durationSeconds, decimals),
        }),
      };
    }
    if (deposit > U128_MAX / durationSeconds) {
      return { field: "deposit", message: t("form.depositTooLarge") };
    }
    if (policy) {
      const rate = deposit / durationSeconds;
      if (BigInt(policy.minRate) > 0n && rate < BigInt(policy.minRate)) {
        return {
          field: "deposit",
          message: t("form.policyRateLow", {
            rate: formatToken(rate, decimals),
            min: formatToken(BigInt(policy.minRate), decimals),
          }),
        };
      }
      if (BigInt(policy.maxRate) > 0n && rate > BigInt(policy.maxRate)) {
        return {
          field: "deposit",
          message: t("form.policyRateHigh", {
            rate: formatToken(rate, decimals),
            max: formatToken(BigInt(policy.maxRate), decimals),
          }),
        };
      }
    }
  }
  return null;
}

/**
 * Every field of the single-stream form, in field order, at most one issue
 * per field. A policy that has not loaded yet (`null`) skips the policy
 * rules — the contract still enforces them, and the rejection is mapped
 * back by `mapCreationErrorToField`.
 */
export function validateStreamForm(
  values: StreamFormValues,
  options: ValidationOptions
): FieldIssue[] {
  const { t, policy } = options;
  const issues: FieldIssue[] = [];

  if (values.asset === "contract") {
    const tokenMessage = validateTokenContractId(values.token, t);
    if (tokenMessage) issues.push({ field: "token", message: tokenMessage });
  }

  const recipientMessage = validateRecipientAddress(values.recipient, t);
  if (recipientMessage) issues.push({ field: "recipient", message: recipientMessage });

  const { seconds, issue: durationIssue } = durationSeconds(values.days, policy, t);
  const depositIssue = validateDeposit(values.deposit, seconds, options);
  if (depositIssue) issues.push(depositIssue);
  if (durationIssue) issues.push(durationIssue);

  return issues;
}

/** One parsed batch row, with the 1-based CSV line it came from. */
interface BatchRow {
  entry: BatchStreamEntry;
  row: number;
}

function batchRows(csv: string, entries: BatchStreamEntry[]): BatchRow[] {
  const lines = csv.split(/\r?\n/);
  const firstNonEmpty = lines.findIndex((line) => line.trim());
  const isHeader = (line: string): boolean => {
    const columns = line.split(",").map((column) => column.trim().toLowerCase());
    return (
      columns.length === 3 &&
      columns[0] === "address" &&
      columns[1] === "rate" &&
      columns[2] === "duration"
    );
  };
  const dataLines: number[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    if (index === firstNonEmpty && isHeader(line)) return;
    dataLines.push(index + 1);
  });
  return entries.map((entry, i) => ({ entry, row: dataLines[i] ?? i + 1 }));
}

function batchRowIssue(row: number, detail: string, t: Formatter): FieldIssue {
  return { field: "csv", message: t("form.batchRowIssue", { row, detail }) };
}

/** Rate/duration/deposit bounds for one batch row, against the same policy. */
function validateBatchRow(
  { entry, row }: BatchRow,
  options: ValidationOptions
): FieldIssue | null {
  const { t, policy, decimals, formatToken } = options;
  const wrap = (detail: string): FieldIssue => batchRowIssue(row, detail, t);

  const recipientMessage = validateRecipientAddress(entry.recipient, t);
  if (recipientMessage) return wrap(recipientMessage);

  const duration = BigInt(entry.duration);
  const deposit = BigInt(entry.deposit);
  if (duration > BigInt(MAX_DURATION_SECONDS)) {
    return wrap(t("form.durationTooLong", { max: MAX_DURATION_SECONDS }));
  }
  if (policy) {
    const actual = Number(duration);
    if (policy.minDuration > 0 && duration < BigInt(policy.minDuration)) {
      return wrap(t("form.policyDurationLow", { actual, min: policy.minDuration }));
    }
    if (policy.maxDuration > 0 && duration > BigInt(policy.maxDuration)) {
      return wrap(t("form.policyDurationHigh", { actual, max: policy.maxDuration }));
    }
    if (BigInt(policy.minDeposit) > 0n && deposit < BigInt(policy.minDeposit)) {
      return wrap(
        t("form.policyDepositLow", {
          min: formatToken(BigInt(policy.minDeposit), decimals),
        })
      );
    }
    const rate = deposit / duration;
    if (BigInt(policy.minRate) > 0n && rate < BigInt(policy.minRate)) {
      return wrap(
        t("form.policyRateLow", {
          rate: formatToken(rate, decimals),
          min: formatToken(BigInt(policy.minRate), decimals),
        })
      );
    }
    if (BigInt(policy.maxRate) > 0n && rate > BigInt(policy.maxRate)) {
      return wrap(
        t("form.policyRateHigh", {
          rate: formatToken(rate, decimals),
          max: formatToken(BigInt(policy.maxRate), decimals),
        })
      );
    }
  }
  return null;
}

/**
 * The batch CSV field: syntax errors keep `parseBatchCsv`'s message (which
 * already names the row), then the batch-size bounds and one issue per row,
 * first failure wins. Returns `null` when the CSV is submittable.
 */
export function validateBatchCsv(
  csv: string,
  options: ValidationOptions
): FieldIssue | null {
  const { t } = options;
  let entries: BatchStreamEntry[];
  try {
    entries = parseBatchCsv(csv);
  } catch (reason) {
    return {
      field: "csv",
      message: reason instanceof Error ? reason.message : String(reason),
    };
  }
  if (entries.length < MIN_BATCH) {
    return { field: "csv", message: t("form.batchEmpty") };
  }
  if (entries.length > MAX_BATCH) {
    return { field: "csv", message: t("form.batchTooLarge", { max: MAX_BATCH }) };
  }
  for (const row of batchRows(csv, entries)) {
    const issue = validateBatchRow(row, options);
    if (issue) return issue;
  }
  return null;
}

export interface SingleCreationContext {
  kind: "single";
  /** Parsed deposit, in smallest units. */
  deposit: bigint;
  /** Duration in seconds, as validated before submit. */
  durationSeconds: bigint;
  policy: StreamPolicyView | null;
  decimals: number;
  formatToken: (raw: bigint, decimals: number) => string;
}

export type CreationContext = SingleCreationContext | { kind: "batch" };

/**
 * Maps a contract/API rejection after submit back to the field that can fix
 * it, using the error catalog (`lib/errors.ts`, generated from
 * `docs/errors/`). Codes with no field fix — clock skew, a frozen contract,
 * an unmapped code — stay form-level with the catalog's remediation.
 *
 * Creation-relevant codes (`contracts/streaming-payments/src/surface.rs`):
 * `#9` non-positive deposit, `#8` duration over the protocol cap, `#11`
 * capacity overflow, `#26` deposit pull, `#28` recipient payout, `#31`
 * asset allowlist, `#42`/`#43` rate floor/ceiling, `#44`/`#45` duration
 * floor/ceiling, `#46` deposit floor, `#47`/`#48` batch empty/too large.
 */
export function mapCreationErrorToField(
  err: unknown,
  t: Formatter,
  context: CreationContext
): MappedRejection {
  const formLevel = (): MappedRejection => ({ field: null, message: describeError(err) });
  const entry = getErrorDetails(err);
  if (!entry) return formLevel();

  switch (entry.code) {
    case 9:
      return { field: "deposit", message: t("form.amountNegative") };
    case 8:
      return {
        field: "duration",
        message: t("form.durationTooLong", { max: MAX_DURATION_SECONDS }),
      };
    case 11:
      return { field: "deposit", message: t("form.depositTooLarge") };
    case 26:
      return { field: "deposit", message: t("form.depositTransferFailed") };
    case 28:
      return { field: "recipient", message: t("form.recipientPayoutFailed") };
    case 31:
      return { field: "token", message: t("form.assetNotAllowed") };
    case 42:
    case 43:
    case 44:
    case 45:
    case 46: {
      if (context.kind !== "single" || !context.policy) return formLevel();
      const { policy, deposit, durationSeconds, decimals, formatToken } = context;
      const rate = deposit / (durationSeconds === 0n ? 1n : durationSeconds);
      if (entry.code === 42) {
        return {
          field: "deposit",
          message: t("form.policyRateLow", {
            rate: formatToken(rate, decimals),
            min: formatToken(BigInt(policy.minRate), decimals),
          }),
        };
      }
      if (entry.code === 43) {
        return {
          field: "deposit",
          message: t("form.policyRateHigh", {
            rate: formatToken(rate, decimals),
            max: formatToken(BigInt(policy.maxRate), decimals),
          }),
        };
      }
      if (entry.code === 44) {
        return {
          field: "duration",
          message: t("form.policyDurationLow", {
            actual: Number(durationSeconds),
            min: policy.minDuration,
          }),
        };
      }
      if (entry.code === 45) {
        return {
          field: "duration",
          message: t("form.policyDurationHigh", {
            actual: Number(durationSeconds),
            max: policy.maxDuration,
          }),
        };
      }
      return {
        field: "deposit",
        message: t("form.policyDepositLow", {
          min: formatToken(BigInt(policy.minDeposit), decimals),
        }),
      };
    }
    case 47:
      return context.kind === "batch"
        ? { field: "csv", message: t("form.batchEmpty") }
        : formLevel();
    case 48:
      return context.kind === "batch"
        ? { field: "csv", message: t("form.batchTooLarge", { max: MAX_BATCH }) }
        : formLevel();
    default:
      return formLevel();
  }
}
