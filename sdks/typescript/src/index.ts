export * from "./generated.js";

export { StreamPayClient, signerFromKeypair } from "./client.js";
export type { Signer, StreamPayClientOptions } from "./client.js";
export { StreamPayMethods } from "./methods.js";
export { decodeError, StreamPayError } from "./errors.js";
export type { ContractFailure, FailureKind, StreamPayErrorOptions } from "./errors.js";
export { decodeEvent, decodeEventXdr, decodeEvents } from "./events.js";
export {
  DEFAULT_RETRY_POLICY,
  backoffCeiling,
  backoffDelay,
  isTransientError,
  resolveRetryPolicy,
  retryAfterMs,
} from "./retry.js";
export type {
  Clock,
  ResolvedRetryPolicy,
  RetryAttemptInfo,
  RetryStage,
  SubmitRetryPolicy,
} from "./retry.js";
export { collectPages } from "./pagination.js";
export type { IndexRole } from "./pagination.js";
export {
  SDK_VERSION,
  Telemetry,
  createTelemetry,
  disableTelemetry,
  enableTelemetry,
  flushTelemetry,
  sdkTelemetry,
  telemetryEnabled,
} from "./telemetry.js";
export type {
  LatencyBucket,
  TelemetryCallInput,
  TelemetryEvent,
  TelemetryOptions,
  TelemetryTransport,
} from "./telemetry.js";
export { subscribeEvents } from "./subscription.js";
export type { StreamFeedEvent, SubscribeEventsOptions } from "./subscription.js";
export {
  FreighterWalletAdapter,
  StandardWalletAdapter,
  WalletCapabilityError,
  WalletRegistry,
  signerFromWalletRegistry,
} from "./wallet-standard.js";
export type {
  FreighterApi,
  SelectedWallet,
  StandardStellarWallet,
  WalletAccount,
  WalletCapabilities,
  WalletConnectOptions,
  WalletDescriptor,
  WalletFeature,
  WalletSelection,
  WalletSignAndSubmitResult,
  WalletStandardAdapter,
  WalletStandardRegistrySource,
  WalletTransactionOptions,
} from "./wallet-standard.js";
