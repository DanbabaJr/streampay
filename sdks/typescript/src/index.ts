export * from "./generated.js";

export { StreamPayClient, signerFromKeypair } from "./client.js";
export type { Signer, StreamPayClientOptions } from "./client.js";
export { StreamPayMethods } from "./methods.js";
export { decodeError, StreamPayError } from "./errors.js";
export type { ContractFailure, FailureKind, StreamPayErrorOptions } from "./errors.js";
export { decodeEvent, decodeEventXdr, decodeEvents } from "./events.js";
export { collectPages } from "./pagination.js";
export type { IndexRole } from "./pagination.js";
