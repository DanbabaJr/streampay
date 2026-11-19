/**
 * Catalog registry and the compile-time contract between a message key and the
 * parameters its call sites must supply.
 */

import type { Locale } from "../locales";
import { en, type MessageKey } from "./en";
import { de } from "./de";

export { en, de };
export type { MessageKey };

/**
 * Every supported locale must provide a full catalog: `Record<MessageKey, string>`
 * means an untranslated or renamed key is a type error, not a runtime fallback.
 */
export const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en, de };

/** A brand no object literal can satisfy, so parameterless keys need no argument. */
declare const noParameters: unique symbol;
export type NoParameters = { readonly [noParameters]: never };

/**
 * A stream id reaches the UI as a `bigint` from the contract read, a `number`
 * from the CLI fixtures, or a `string` from a URL segment; the message renders
 * `#{id}` and ICU stringifies all three identically.
 */
export type StreamId = string | number | bigint;

/**
 * Keys that interpolate values, and the shape each call site must pass.
 * A key absent here is required to be parameterless; the catalog gate in
 * lib/i18n/catalog.spec.ts fails the test run if a message contains a
 * `{placeholder}` that is missing from this map, so the two stay in step.
 */
export interface MessageParams {
  "chrome.networkLive": { network: string };
  "chrome.networkText": { network: string };
  "chrome.contractLabel": { shortId: string };
  "chrome.contractAria": { contractId: string };
  "chrome.walletOnNetwork": { network: string };
  "chrome.appSignsFor": { network: string };
  "home.connectedAs": { address: string };
  "home.discovered": { count: number };
  "home.streamLoaded": { id: StreamId };
  "home.created": { id: StreamId };
  "home.batchCreated": { count: number; ids: string };
  "home.withdrew": { amount: string; id: StreamId };
  "home.claimed": { amount: string; id: StreamId };
  "home.toppedUp": { amount: string; id: StreamId };
  "home.cancelled": { id: StreamId };
  "home.walletFailed": { reason: string };
  "pay.invoice.title": { id: StreamId };
  "pay.invoice.progress": { percent: string };
  "pay.invoice.total": { amount: string; unit: string };
  "pay.action.claim": { amount: string };
  "meta.pay.title": { status: string; amount: string; unit: string; brand: string };
  "meta.pay.description": { amount: string; unit: string };
  "form.amountGroupedOnly": { separator: string };
  "form.amountTooPrecise": { decimals: number };
  "form.amountAmbiguous": { input: string; group: string; decimal: string };
  "form.nativeContractNote": { contractId: string };
  "form.amountsNote": { decimals: number; code: string };
  "form.policyDepositLow": { min: string };
  "form.policyDurationLow": { actual: number; min: number };
  "form.policyDurationHigh": { actual: number; max: number };
  "form.policyRateLow": { rate: string; min: string };
  "form.policyRateHigh": { rate: string; max: string };
}

export type ParamsOf<K extends MessageKey> = K extends keyof MessageParams
  ? MessageParams[K]
  : NoParameters;

/** `()` for a parameterless key, `(params)` for one that interpolates. */
export type MessageArgs<K extends MessageKey> = ParamsOf<K> extends NoParameters
  ? []
  : [params: ParamsOf<K>];

export function catalogFor(locale: Locale): Record<MessageKey, string> {
  return CATALOGS[locale];
}

/**
 * Sample values for every parameterized key. They are the fixtures for the
 * per-locale snapshot suite *and* the runtime list of keys that interpolate:
 * the mapped type makes it a compile error to add a key to `MessageParams`
 * without adding a sample here, so the two can never drift apart.
 */
export const MESSAGE_SAMPLES: { [K in keyof MessageParams]: MessageParams[K] } = {
  "chrome.networkLive": { network: "Testnet" },
  "chrome.networkText": { network: "Testnet" },
  "chrome.contractLabel": { shortId: "CAAP…AB4D" },
  "chrome.contractAria": { contractId: "CAAP5FRQ…AB4D" },
  "chrome.walletOnNetwork": { network: "Public Network (mainnet)" },
  "chrome.appSignsFor": { network: "Testnet" },
  "home.connectedAs": { address: "GABC1234" },
  "home.discovered": { count: 3 },
  "home.streamLoaded": { id: 42 },
  "home.created": { id: 42 },
  "home.batchCreated": { count: 2, ids: "#41, #42" },
  "home.withdrew": { amount: "1,5", id: 42 },
  "home.claimed": { amount: "1,5", id: 42 },
  "home.toppedUp": { amount: "1,5", id: 42 },
  "home.cancelled": { id: 42 },
  "home.walletFailed": { reason: "user rejected" },
  "pay.invoice.title": { id: 42 },
  "pay.invoice.progress": { percent: "35%" },
  "pay.invoice.total": { amount: "1.000", unit: "tokens" },
  "pay.action.claim": { amount: "0,0000001" },
  "meta.pay.title": { status: "Active Stream", amount: "1.000", unit: "Tokens", brand: "StreamPay" },
  "meta.pay.description": { amount: "1.000", unit: "Tokens" },
  "form.amountGroupedOnly": { separator: "." },
  "form.amountTooPrecise": { decimals: 7 },
  "form.amountAmbiguous": { input: "1,234.56", group: ".", decimal: "," },
  "form.nativeContractNote": { contractId: "CAAP…AB4D" },
  "form.amountsNote": { decimals: 7, code: "XLM" },
  "form.policyDepositLow": { min: "1000" },
  "form.policyDurationLow": { actual: 60, min: 300 },
  "form.policyDurationHigh": { actual: 60, max: 300 },
  "form.policyRateLow": { rate: "1", min: "10" },
  "form.policyRateHigh": { rate: "100", max: "10" },
};

/** Every key, in catalog order. Used by the snapshot suite and the CI check. */
export const MESSAGE_KEYS = Object.keys(en) as MessageKey[];

/** The keys that interpolate, derived from the sample map above. */
export const PARAMETERIZED_KEYS = Object.keys(MESSAGE_SAMPLES) as (keyof MessageParams)[];
