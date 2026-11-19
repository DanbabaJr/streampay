/**
 * WebAuthn passkey registration and login flows for StreamPay — Issue #70.
 *
 * Wraps the browser's `navigator.credentials` API and bridges to the
 * on-chain `passkey-signer` contract via the Soroban RPC client.
 *
 * # Security notes (full discussion in contracts/passkey-signer/src/lib.rs)
 *
 * ## Attestation vs assertion
 *
 * - **Registration** (`register`): Calls `navigator.credentials.create()`.
 *   The browser produces an attestation object. We extract the P-256 public
 *   key from the uncompressed COSE key in `attestationObject.authData` and
 *   register it on-chain. We do NOT verify the attestation statement — the
 *   on-chain contract only guards assertions (signatures). Off-chain attestation
 *   verification against FIDO MDS3 is recommended for high-security deployments.
 *
 * - **Login / claim** (`login`): Calls `navigator.credentials.get()`.
 *   The browser produces an assertion (signature over `authData + hash(CDJ)`).
 *   We call the on-chain `verify_and_record` entry point which performs full
 *   WebAuthn Level 3 assertion verification.
 *
 * ## What the relying party can verify on-chain
 *
 * - Signature was produced by the private key paired with the registered P-256
 *   public key (device-bound on platform authenticators).
 * - The `rpId` matches the registered one (cross-origin replay prevention).
 * - The challenge was not previously used (nonce replay prevention).
 * - User-presence gesture occurred.
 *
 * ## What cannot be verified on-chain
 *
 * - Which specific device or FIDO certification level produced the credential.
 * - User-verification was performed (UV flag check is opt-in per registration).
 * - That the credential is not cloned (platform binding is a platform guarantee,
 *   not a cryptographic proof).
 */

import {
  Account,
  Address,
  Contract,
  Networks,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";

// ── Configuration ─────────────────────────────────────────────────────────────

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";
const NETWORK =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;
const PASSKEY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_PASSKEY_CONTRACT_ID ?? "";
const RP_ID =
  process.env.NEXT_PUBLIC_PASSKEY_RP_ID ?? "streampay.app";
const RP_ORIGIN =
  process.env.NEXT_PUBLIC_PASSKEY_ORIGIN ??
  (typeof window !== "undefined" ? window.location.origin : "https://streampay.app");

const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PasskeyRegistrationResult {
  /** The Stellar address that owns the registered credential. */
  owner: string;
  /** P-256 public key X coordinate (hex). */
  x: string;
  /** P-256 public key Y coordinate (hex). */
  y: string;
  /** SHA-256 of the RP ID (hex). */
  rpIdHash: string;
  /** Transaction hash of the registration. */
  txHash: string;
}

export interface PasskeyLoginResult {
  /** Whether the on-chain assertion verification succeeded. */
  success: boolean;
  /** Transaction hash of the verify_and_record call. */
  txHash: string;
}

// ── COSE / CBOR helpers (minimal, no external parser) ─────────────────────────

/**
 * Extracts the uncompressed P-256 public key (x, y) from a COSE_Key encoded
 * in the `authData` `attestedCredentialData` section.
 *
 * COSE_Key format (EC2, P-256):
 *   map{ 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x (32 bytes), -3: y (32 bytes) }
 *
 * We use a minimal byte scanner rather than a full CBOR parser.
 */
export function extractP256KeyFromAuthData(authData: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  // authData layout:
  //   [0..32]   rpIdHash
  //   [32]      flags
  //   [33..36]  signCount (4 bytes)
  //   [37..52]  AAGUID (16 bytes)  — only in attestation
  //   [53..54]  credentialIdLength (2 bytes)
  //   [55..]    credentialId (credentialIdLength bytes)
  //   [55+L..]  credentialPublicKey (CBOR COSE_Key)
  if (authData.length < 55) throw new Error("authData too short for attestation");
  const credIdLen = (authData[53] << 8) | authData[54];
  const coseStart = 55 + credIdLen;
  if (authData.length < coseStart + 77) throw new Error("authData too short for COSE key");

  const cose = authData.slice(coseStart);
  // Scan for CBOR map entries with keys -2 (x) and -3 (y).
  // CBOR major type 2 (byte string), length 32 = 0x58 0x20.
  const x = findCoseByteString(cose, -2);
  const y = findCoseByteString(cose, -3);
  if (!x || !y) throw new Error("could not extract P-256 x/y from COSE_Key");
  return { x, y };
}

/**
 * Minimal CBOR scanner for COSE EC2 key parameters.
 * Finds the 32-byte value for COSE key integer `label` (-2 or -3).
 */
function findCoseByteString(cose: Uint8Array, label: number): Uint8Array | null {
  // Encode label as CBOR negative integer: (-1 - label) using major type 1.
  // label=-2 → 0x21; label=-3 → 0x22
  const cbor_label = 0x20 | ((-1 - label) & 0x1F);
  for (let i = 0; i < cose.length - 34; i++) {
    if (cose[i] === cbor_label) {
      // Next bytes should be 0x58 0x20 (byte string of length 32).
      if (cose[i + 1] === 0x58 && cose[i + 2] === 0x20) {
        return cose.slice(i + 3, i + 35);
      }
    }
  }
  return null;
}

/**
 * Returns the SHA-256 hash of the RP ID as a Uint8Array.
 */
export async function rpIdHash(): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const data = encoder.encode(RP_ID);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuf);
}

// ── Base64url helpers ─────────────────────────────────────────────────────────

function bufferToHex(buf: Uint8Array): string {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64urlToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    b64.length + (4 - (b64.length % 4)) % 4, "="
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function bytesToBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ── Soroban call helpers ──────────────────────────────────────────────────────

function passkeyContract(): Contract {
  if (!PASSKEY_CONTRACT_ID) throw new Error("NEXT_PUBLIC_PASSKEY_CONTRACT_ID is not set");
  return new Contract(PASSKEY_CONTRACT_ID);
}

function scAddr(s: string) {
  return nativeToScVal(new Address(s), { type: "address" });
}

function scBytes32(hex: string): xdr.ScVal {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return nativeToScVal(Buffer.from(bytes), { type: "bytes" });
}

async function sendAndWait(source: string, op: xdr.Operation): Promise<string> {
  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase: NETWORK })
    .addOperation(op)
    .setTimeout(60)
    .build();
  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) throw new Error(`Simulation failed: ${simulated.error}`);
  const ready = rpc.assembleTransaction(tx, simulated).build();
  const { signedTxXdr } = await signTransaction(ready.toXDR(), { networkPassphrase: NETWORK });
  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK);
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") throw new Error(`Submit failed: ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error("Transaction failed");
  }
  throw new Error("Timed out");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Registers a new passkey for `owner`.
 *
 * 1. Calls `navigator.credentials.create()` to create a new P-256 credential.
 * 2. Extracts the (x, y) public key from the attestation authData.
 * 3. Calls `passkey-signer.register(owner, rp_id_hash, x, y, flags)` on-chain.
 *
 * The owner must have a Freighter wallet to sign the registration transaction.
 */
export async function registerPasskey(
  owner: string,
  requireUV = false
): Promise<PasskeyRegistrationResult> {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new Error("WebAuthn is not available in this environment");
  }

  // Generate a random user ID (32 bytes).
  const userId = crypto.getRandomValues(new Uint8Array(32));
  // Challenge (32 bytes) — for registration we use a random value.
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: RP_ID, name: "StreamPay" },
      user: { id: userId, name: owner, displayName: owner },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 = P-256
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: requireUV ? "required" : "preferred",
        residentKey: "required",
      },
      timeout: 60_000,
      attestation: "none", // See security notes in lib.rs
    },
  })) as PublicKeyCredential | null;

  if (!cred) throw new Error("Passkey registration was cancelled");
  const response = cred.response as AuthenticatorAttestationResponse;

  const authData = new Uint8Array(response.getAuthenticatorData());
  const { x, y } = extractP256KeyFromAuthData(authData);
  const rpHash = await rpIdHash();

  const flags = requireUV ? 1 : 0; // REGISTRATION_FLAGS_REQUIRE_UV = 1

  const op = passkeyContract().call(
    "register",
    scAddr(owner),
    scBytes32(bufferToHex(rpHash)),
    scBytes32(bufferToHex(x)),
    scBytes32(bufferToHex(y)),
    nativeToScVal(flags, { type: "u32" })
  );

  const txHash = await sendAndWait(owner, op);

  return {
    owner,
    x: bufferToHex(x),
    y: bufferToHex(y),
    rpIdHash: bufferToHex(rpHash),
    txHash,
  };
}

/**
 * Performs a WebAuthn login assertion and verifies it on-chain.
 *
 * 1. Generates a fresh 32-byte challenge.
 * 2. Calls `navigator.credentials.get()` to get a P-256 assertion.
 * 3. Decodes the DER-encoded signature into (r, s).
 * 4. Calls `passkey-signer.verify_and_record(owner, authData, CDJ, challenge, r, s)`.
 *
 * After a successful `verify_and_record`, the caller can use the nonce
 * (recorded on-chain) to gate a downstream `streaming-payments.withdraw_max`
 * call via a smart-account check.
 */
export async function loginWithPasskey(owner: string): Promise<PasskeyLoginResult> {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new Error("WebAuthn is not available in this environment");
  }

  // Fresh 32-byte challenge for this assertion.
  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: challengeBytes,
      rpId: RP_ID,
      userVerification: "preferred",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("Passkey login was cancelled");
  const response = assertion.response as AuthenticatorAssertionResponse;

  const authData = new Uint8Array(response.authenticatorData);
  const clientDataJson = new Uint8Array(response.clientDataJSON);
  const signature = new Uint8Array(response.signature);

  // Decode DER-encoded ECDSA signature into (r, s).
  const { r, s } = decodeDerSignature(signature);

  // Build Soroban BytesN<32> args.
  const toScBytes32 = (arr: Uint8Array) => {
    if (arr.length !== 32) throw new Error(`expected 32 bytes, got ${arr.length}`);
    return nativeToScVal(Buffer.from(arr), { type: "bytes" });
  };

  const authDataVal = nativeToScVal(Buffer.from(authData), { type: "bytes" });
  const cdjVal = nativeToScVal(Buffer.from(clientDataJson), { type: "bytes" });
  const challengeVal = toScBytes32(challengeBytes);
  const rVal = toScBytes32(r);
  const sVal = toScBytes32(s);

  const op = passkeyContract().call(
    "verify_and_record",
    scAddr(owner),
    authDataVal,
    cdjVal,
    challengeVal,
    rVal,
    sVal
  );

  const txHash = await sendAndWait(owner, op);
  return { success: true, txHash };
}

/**
 * Decodes a DER-encoded ECDSA signature into its (r, s) 32-byte components.
 *
 * WebAuthn authenticators produce DER-encoded signatures:
 *   SEQUENCE { INTEGER r, INTEGER s }
 * We need the raw 32-byte big-endian values for on-chain verification.
 */
export function decodeDerSignature(der: Uint8Array): { r: Uint8Array; s: Uint8Array } {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("not a DER SEQUENCE");
  // Skip length byte(s).
  if (der[offset] & 0x80) offset += (der[offset] & 0x7F) + 1;
  else offset += 1;

  function readInteger(): Uint8Array {
    if (der[offset++] !== 0x02) throw new Error("expected DER INTEGER");
    const len = der[offset++];
    const raw = der.slice(offset, offset + len);
    offset += len;
    // Strip leading zero byte (sign indicator) and pad to 32 bytes.
    const stripped = raw[0] === 0 ? raw.slice(1) : raw;
    const padded = new Uint8Array(32);
    padded.set(stripped, 32 - stripped.length);
    return padded;
  }

  const r = readInteger();
  const s = readInteger();
  return { r, s };
}

/**
 * Checks whether a passkey is registered for the given owner address.
 * Uses a read-only simulation — no Freighter required.
 */
export async function isPasskeyRegistered(owner: string): Promise<boolean> {
  if (!PASSKEY_CONTRACT_ID) return false;
  const server = new rpc.Server(RPC_URL);
  const contract = passkeyContract();
  const op = contract.call("get_credential", scAddr(owner));
  const tx = new TransactionBuilder(DUMMY_SOURCE, { fee: "100", networkPassphrase: NETWORK })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return false;
  // If simulation succeeded without error, a credential exists.
  return true;
}
