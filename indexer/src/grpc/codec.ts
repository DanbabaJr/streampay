// Minimal protobuf codec for `grpc/events.proto` (issue #579).
//
// Hand-written, no new dependency: only the wire types this schema uses
// (varint = 0 and length-delimited = 2) are encoded, and the decoder skips
// unknown fields of any wire type, so an additive proto change stays
// decodable. Field numbers/names are the ones declared in events.proto;
// `grpc.test.ts` asserts the proto, the registry and the generated table
// agree, so a drift here fails the freshness gate rather than silently
// shipping a different wire shape.

export interface StreamEventMessage {
  seq: number;
  eventId: string;
  streamId: string;
  name: string;
  ledger: number;
  ledgerClosedAt: string;
  payloadJson: string;
  idempotencyKey: string;
  cursor: number;
  redacted: boolean;
}

export interface SubscribeRequestMessage {
  streamId: string;
  cursor: number;
  initialCredit: number;
  tenant: string;
  redactAddresses: boolean;
  eventNames: string[];
  limit: number;
}

export interface AckRequestMessage {
  subscriptionId: string;
  tenant: string;
  streamId: string;
  ackedSeq: number;
  credit: number;
}

export interface AckResponseMessage {
  ackedSeq: number;
  creditAvailable: number;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Varints (uint64, BigInt-safe)
// ---------------------------------------------------------------------------

export function encodeVarint(value: bigint | number): Buffer {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) throw new Error("protobuf varint must be non-negative");
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return Buffer.from(out);
}

export function decodeVarint(buf: Buffer, offset: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  }
  return { value: result, next: pos };
}

function toSafeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

// ---------------------------------------------------------------------------
// Writer / Reader
// ---------------------------------------------------------------------------

class Writer {
  private chunks: Buffer[] = [];

  tag(field: number, wireType: number): void {
    this.chunks.push(encodeVarint(BigInt((field << 3) | wireType)));
  }
  varintField(field: number, value: bigint | number): void {
    if (value === 0 || value === 0n) return; // proto3 default: omit
    this.tag(field, 0);
    this.chunks.push(encodeVarint(value));
  }
  boolField(field: number, value: boolean): void {
    if (!value) return;
    this.tag(field, 0);
    this.chunks.push(Buffer.from([1]));
  }
  stringField(field: number, value: string): void {
    if (value === "") return;
    const bytes = Buffer.from(value, "utf8");
    this.tag(field, 2);
    this.chunks.push(encodeVarint(BigInt(bytes.length)), bytes);
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  readTag(): { field: number; wireType: number } {
    const { value, next } = decodeVarint(this.buf, this.pos);
    this.pos = next;
    return { field: Number(value >> 3n), wireType: Number(value & 0x7n) };
  }

  readVarint(): bigint {
    const { value, next } = decodeVarint(this.buf, this.pos);
    this.pos = next;
    return value;
  }

  readString(): string {
    const { value: len, next } = decodeVarint(this.buf, this.pos);
    const start = next;
    const end = start + Number(len);
    if (end > this.buf.length) throw new Error("truncated length-delimited field");
    this.pos = end;
    return this.buf.subarray(start, end).toString("utf8");
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2: {
        const { value: len, next } = decodeVarint(this.buf, this.pos);
        this.pos = next + Number(len);
        break;
      }
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
    if (this.pos > this.buf.length) throw new Error("truncated protobuf field");
  }
}

// ---------------------------------------------------------------------------
// Message codecs (field numbers per events.proto)
// ---------------------------------------------------------------------------

export function encodeStreamEvent(e: StreamEventMessage): Buffer {
  const w = new Writer();
  w.varintField(1, BigInt(e.seq));
  w.stringField(2, e.eventId);
  w.stringField(3, e.streamId);
  w.stringField(4, e.name);
  w.varintField(5, BigInt(e.ledger));
  w.stringField(6, e.ledgerClosedAt);
  w.stringField(7, e.payloadJson);
  w.stringField(8, e.idempotencyKey);
  w.varintField(9, BigInt(e.cursor));
  w.boolField(10, e.redacted);
  return w.bytes();
}

export function decodeStreamEvent(buf: Buffer): StreamEventMessage {
  const r = new Reader(buf);
  const out: StreamEventMessage = {
    seq: 0,
    eventId: "",
    streamId: "",
    name: "",
    ledger: 0,
    ledgerClosedAt: "",
    payloadJson: "",
    idempotencyKey: "",
    cursor: 0,
    redacted: false,
  };
  while (!r.done) {
    const { field, wireType } = r.readTag();
    switch (field) {
      case 1: out.seq = toSafeNumber(r.readVarint(), "seq"); break;
      case 2: out.eventId = r.readString(); break;
      case 3: out.streamId = r.readString(); break;
      case 4: out.name = r.readString(); break;
      case 5: out.ledger = toSafeNumber(r.readVarint(), "ledger"); break;
      case 6: out.ledgerClosedAt = r.readString(); break;
      case 7: out.payloadJson = r.readString(); break;
      case 8: out.idempotencyKey = r.readString(); break;
      case 9: out.cursor = toSafeNumber(r.readVarint(), "cursor"); break;
      case 10: out.redacted = r.readVarint() !== 0n; break;
      default: r.skip(wireType);
    }
  }
  return out;
}

export function encodeSubscribeRequest(rq: SubscribeRequestMessage): Buffer {
  const w = new Writer();
  w.stringField(1, rq.streamId);
  w.varintField(2, BigInt(rq.cursor));
  w.varintField(3, BigInt(rq.initialCredit));
  w.stringField(4, rq.tenant);
  w.boolField(5, rq.redactAddresses);
  for (const name of rq.eventNames) w.stringField(6, name);
  w.varintField(7, BigInt(rq.limit));
  return w.bytes();
}

export function decodeSubscribeRequest(buf: Buffer): SubscribeRequestMessage {
  const r = new Reader(buf);
  const out: SubscribeRequestMessage = {
    streamId: "",
    cursor: 0,
    initialCredit: 0,
    tenant: "",
    redactAddresses: false,
    eventNames: [],
    limit: 0,
  };
  while (!r.done) {
    const { field, wireType } = r.readTag();
    switch (field) {
      case 1: out.streamId = r.readString(); break;
      case 2: out.cursor = toSafeNumber(r.readVarint(), "cursor"); break;
      case 3: out.initialCredit = toSafeNumber(r.readVarint(), "initial_credit"); break;
      case 4: out.tenant = r.readString(); break;
      case 5: out.redactAddresses = r.readVarint() !== 0n; break;
      case 6: out.eventNames.push(r.readString()); break;
      case 7: out.limit = toSafeNumber(r.readVarint(), "limit"); break;
      default: r.skip(wireType);
    }
  }
  return out;
}

export function encodeAckRequest(rq: AckRequestMessage): Buffer {
  const w = new Writer();
  w.stringField(1, rq.subscriptionId);
  w.stringField(2, rq.tenant);
  w.stringField(3, rq.streamId);
  w.varintField(4, BigInt(rq.ackedSeq));
  w.varintField(5, BigInt(rq.credit));
  return w.bytes();
}

export function decodeAckRequest(buf: Buffer): AckRequestMessage {
  const r = new Reader(buf);
  const out: AckRequestMessage = {
    subscriptionId: "",
    tenant: "",
    streamId: "",
    ackedSeq: 0,
    credit: 0,
  };
  while (!r.done) {
    const { field, wireType } = r.readTag();
    switch (field) {
      case 1: out.subscriptionId = r.readString(); break;
      case 2: out.tenant = r.readString(); break;
      case 3: out.streamId = r.readString(); break;
      case 4: out.ackedSeq = toSafeNumber(r.readVarint(), "acked_seq"); break;
      case 5: out.credit = toSafeNumber(r.readVarint(), "credit"); break;
      default: r.skip(wireType);
    }
  }
  return out;
}

export function encodeAckResponse(rs: AckResponseMessage): Buffer {
  const w = new Writer();
  w.varintField(1, BigInt(rs.ackedSeq));
  w.varintField(2, BigInt(rs.creditAvailable));
  w.boolField(3, rs.active);
  return w.bytes();
}

export function decodeAckResponse(buf: Buffer): AckResponseMessage {
  const r = new Reader(buf);
  const out: AckResponseMessage = { ackedSeq: 0, creditAvailable: 0, active: false };
  while (!r.done) {
    const { field, wireType } = r.readTag();
    switch (field) {
      case 1: out.ackedSeq = toSafeNumber(r.readVarint(), "acked_seq"); break;
      case 2: out.creditAvailable = toSafeNumber(r.readVarint(), "credit_available"); break;
      case 3: out.active = r.readVarint() !== 0n; break;
      default: r.skip(wireType);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// gRPC framing: 1-byte compression flag (0 = uncompressed) + 4-byte BE length
// ---------------------------------------------------------------------------

export function encodeGrpcFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Pull complete gRPC frames out of `buf`. Returns the decoded message
 * payloads and any trailing partial frame, so a caller can keep buffering
 * across DATA frames without losing a split message.
 */
export function decodeGrpcFrames(buf: Buffer): { messages: Buffer[]; rest: Buffer } {
  const messages: Buffer[] = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    if (buf[pos] !== 0) throw new Error(`unsupported gRPC compression flag ${buf[pos]}`);
    const len = buf.readUInt32BE(pos + 1);
    if (pos + 5 + len > buf.length) break;
    messages.push(buf.subarray(pos + 5, pos + 5 + len));
    pos += 5 + len;
  }
  return { messages, rest: buf.subarray(pos) };
}
