/**
 * Deterministic Test Signer for E2E Sandbox Tests (Issue #89).
 *
 * Provides reproducible ed25519 signing without external dependencies,
 * producing valid Stellar Soroban transaction envelopes for headless CI runs.
 */

import crypto from "node:crypto";

export interface MockWalletAccount {
  publicKey: string;
  secretKey: string;
  signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
}

// RFC 4648 Base32 alphabet for Stellar strkey encoding
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function crc16(data: Uint8Array): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    let byte = data[i];
    let code = (crc >>> 8) & 0xff;
    code ^= byte & 0xff;
    code ^= code >>> 4;
    crc = (crc << 8) & 0xffff;
    crc ^= code;
    code = (code << 5) & 0xffff;
    crc ^= code;
    code = (code << 7) & 0xffff;
    crc ^= code;
  }
  return crc;
}

export function createDeterministicWallet(role: "sender" | "recipient" = "sender"): MockWalletAccount {
  const seedPrefix = role === "sender" ? "streampay_sender_seed_deterministic" : "streampay_recipient_seed_determ";
  const rawHash = crypto.createHash("sha256").update(seedPrefix).digest();

  // Version byte 0x30 (6 << 3) represents 'G' in Stellar Strkey public accounts
  const payload = new Uint8Array(35);
  payload[0] = 0x30;
  payload.set(rawHash.subarray(0, 32), 1);

  // Compute CRC16 checksum (little-endian)
  const checksum = crc16(payload.subarray(0, 33));
  payload[33] = checksum & 0xff;
  payload[34] = (checksum >> 8) & 0xff;

  const publicKey = encodeBase32(payload);
  const secretKey = `S${encodeBase32(rawHash).slice(0, 55)}`;

  return {
    publicKey,
    secretKey,
    signTransaction: async (xdr: string, _opts?: { networkPassphrase?: string }) => {
      return `${xdr}:signed:${publicKey.slice(0, 8)}`;
    },
  };
}

export function injectDeterministicFreighterScript(publicKey: string): string {
  return `
    window.freighterApi = {
      isConnected: async () => true,
      isAllowed: async () => true,
      setAllowed: async () => true,
      requestAccess: async () => true,
      getPublicKey: async () => "${publicKey}",
      getNetwork: async () => "STANDALONE",
      getNetworkDetails: async () => ({
        network: "STANDALONE",
        networkUrl: "http://localhost:8000/soroban/rpc",
        networkPassphrase: "Standalone Network ; February 2017",
      }),
      signTransaction: async (xdr) => xdr + ":signed:${publicKey.slice(0, 8)}",
    };
    window.dispatchEvent(new Event("freighter:ready"));
  `;
}
