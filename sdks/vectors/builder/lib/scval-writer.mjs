/**
 * Minimal XDR writer for the Soroban values used by the conformance vectors.
 *
 * The fixtures are built from real event payloads captured by the contract's
 * own test run (contracts/streaming-payments/test_snapshots) and signed
 * transaction envelopes. stellar-sdk builds the envelopes; this module only
 * re-encodes event `ScVal`s and results to base64 so that every SDK can decode
 * them from raw XDR, independently of this builder.
 */

export const i32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

export const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

export const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

/** Two's-complement 128-bit big-endian. */
export const i128 = (n) => {
  let value = BigInt(n);
  const b = Buffer.alloc(16);
  if (value < 0n) value = (1n << 128n) + value;
  b.writeBigUInt64BE(value >> 64n, 0);
  b.writeBigUInt64BE(value & 0xffffffffffffffffn, 8);
  return b;
};

const pad4 = (b) => {
  const rest = b.length % 4;
  return rest === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - rest)]);
};

const varOpaque = (b) => Buffer.concat([u32(b.length), pad4(b)]);

/** XDR variable-length string/symbol body (length + padded bytes). */
const xdrString = (s) => varOpaque(Buffer.from(s, "utf8"));

const fixedOpaque = (hexOrBuffer) =>
  Buffer.isBuffer(hexOrBuffer) ? hexOrBuffer : Buffer.from(hexOrBuffer, "hex");

// ScValType discriminants (Soroban XDR).
const SCV = {
  bool: 0,
  void: 1,
  error: 2,
  u32: 3,
  i32: 4,
  u64: 5,
  i64: 6,
  timepoint: 7,
  duration: 8,
  u128: 9,
  i128: 10,
  u256: 11,
  i256: 12,
  bytes: 13,
  string: 14,
  symbol: 15,
  vec: 16,
  map: 17,
  address: 18,
};

/** SCAddress union: 0 = account (ed25519), 1 = contract. */
const scAddress = (strkey, StrKey) => {
  if (strkey.startsWith("C")) {
    // SC_ADDRESS_TYPE_CONTRACT = 1
    return Buffer.concat([i32(1), fixedOpaque(StrKey.decodeContract(strkey))]);
  }
  if (strkey.startsWith("G")) {
    // SC_ADDRESS_TYPE_ACCOUNT = 0, PUBLIC_KEY_TYPE_ED25519 = 0
    return Buffer.concat([
      i32(0),
      i32(0),
      fixedOpaque(StrKey.decodeEd25519PublicKey(strkey)),
    ]);
  }
  throw new Error(`unsupported address ${strkey}`);
};

/**
 * Encodes a value described by a fixture JSON node (the same JSON shape the
 * contract test snapshots use) into ScVal XDR.
 *
 * Supported: bool, void, u32/u64/i32/i128, symbol, string, address, map, vec.
 */
export const scValFromJson = (node, StrKey) => {
  if (typeof node === "boolean" || "bool" in node) {
    return Buffer.concat([i32(SCV.bool), i32(node.bool ? 1 : 0)]);
  }
  if ("void" in node) return i32(SCV.void);
  if ("u32" in node) {
    return Buffer.concat([i32(SCV.u32), u32(Number(node.u32))]);
  }
  if ("i32" in node) {
    return Buffer.concat([i32(SCV.i32), i32(Number(node.i32))]);
  }
  if ("u64" in node) {
    return Buffer.concat([i32(SCV.u64), u64(node.u64)]);
  }
  if ("i128" in node) {
    return Buffer.concat([i32(SCV.i128), i128(node.i128)]);
  }
  if ("u128" in node) {
    let value = BigInt(node.u128);
    const b = Buffer.alloc(16);
    b.writeBigUInt64BE(value >> 64n, 0);
    b.writeBigUInt64BE(value & 0xffffffffffffffffn, 8);
    return Buffer.concat([i32(SCV.u128), b]);
  }
  if ("symbol" in node) {
    return Buffer.concat([i32(SCV.symbol), xdrString(node.symbol)]);
  }
  if ("string" in node) {
    return Buffer.concat([i32(SCV.string), xdrString(node.string)]);
  }
  if ("address" in node) {
    return Buffer.concat([i32(SCV.address), scAddress(node.address, StrKey)]);
  }
  if ("map" in node) {
    const entries = node.map.flatMap((entry) => [
      scValFromJson(entry.key, StrKey),
      scValFromJson(entry.val, StrKey),
    ]);
    return Buffer.concat([i32(SCV.map), i32(1), u32(node.map.length), ...entries]);
  }
  if ("vec" in node) {
    return Buffer.concat([
      i32(SCV.vec),
      i32(1),
      u32(node.vec.length),
      ...node.vec.map((item) => scValFromJson(item, StrKey)),
    ]);
  }
  throw new Error(`cannot encode ScVal JSON node: ${JSON.stringify(node)}`);
};

/** Encodes a `ContractEvent` (type = contract) to base64. */
export const contractEventXdr = (event, StrKey) => {
  const { contract_id: contractId, body } = event;
  const topics = body.v0.topics.map((topic) => scValFromJson(topic, StrKey));
  const data = scValFromJson(body.v0.data, StrKey);
  const bytes = Buffer.concat([
    i32(0), // ExtensionPoint ext = v0
    i32(1),
    fixedOpaque(StrKey.decodeContract(contractId)),
    i32(1), // CONTRACT_EVENT_TYPE_CONTRACT
    i32(0), // body union arm v0
    u32(topics.length),
    ...topics,
    data,
  ]);
  return bytes.toString("base64");
};

/** Encodes a plain ScVal value to base64. */
export const scValXdr = (node, StrKey) =>
  scValFromJson(node, StrKey).toString("base64");

/** Encodes `ScVal::Error(SCError::Contract(code))` to base64. */
export const contractErrorScValXdr = (code) =>
  Buffer.concat([i32(SCV.error), i32(0), u32(code)]).toString("base64");
