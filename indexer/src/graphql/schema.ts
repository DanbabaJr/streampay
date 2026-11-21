/**
 * GraphQL schema for the indexer read API (#576).
 *
 * The SDL is the single source of truth for the graph: `GET /graphql/schema`
 * serves it verbatim, and the freshness-gate test asserts every scalar
 * `Stream` field in it exists on the `Stream` projection type, so a
 * projection/schema drift fails CI instead of silently serving stale fields.
 *
 * Field naming: scalar stream fields mirror the REST JSON shape
 * (`streamId`, `startTime`, …) with snake_case REST keys mapped to camelCase
 * (`cancelled_by` -> `cancelledBy`). See `STREAM_FIELD_MAP`.
 */
export const GRAPHQL_SDL = `
type Stream {
  id: String
  streamId: String!
  sender: String
  recipient: String
  token: String
  deposit: String
  withdrawn: String!
  startTime: String
  endTime: String
  cancelable: Boolean
  status: String!
  cancelledBy: String
  recipientAmount: String
  senderAmount: String
  refundTarget: String
  lastLedger: Int!
  updatedAt: String!
  senderAddress: Address
  recipientAddress: Address
  events(first: Int, after: String): EventConnection!
  forecast(at: Int): Forecast!
}

type Address {
  address: String!
  streams(first: Int, after: String): StreamConnection!
  streamCount: Int!
}

type Event {
  id: String!
  streamId: String
  eventType: String!
  ledger: Int!
  ledgerClosedAt: String!
  txHash: String
  seq: Int
  payload: String
}

type Forecast {
  streamId: String!
  accrued: String!
  available: String!
  projectedTotal: String!
  ratePerSecond: String!
  secondsRemaining: Int!
  asOf: Int!
}

type WebhookSubscription {
  id: String!
  url: String!
  events: [String!]!
  status: String!
  createdAt: String!
  updatedAt: String!
}

type StreamEdge {
  node: Stream!
  cursor: String!
}

type StreamConnection {
  edges: [StreamEdge!]!
  nodes: [Stream!]!
  totalCount: Int!
  pageInfo: PageInfo!
}

type EventEdge {
  node: Event!
  cursor: String!
}

type EventConnection {
  edges: [EventEdge!]!
  nodes: [Event!]!
  totalCount: Int!
  pageInfo: PageInfo!
}

type PageInfo {
  hasNextPage: Boolean!
  nextCursor: String
}

type Query {
  stream(id: ID!): Stream
  streamsByRecipient(recipient: String!, first: Int, after: String): StreamConnection!
  streamsByAddress(address: String!, first: Int, after: String): StreamConnection!
  address(address: String!): Address
  streamHistory(streamId: ID!, first: Int, after: String): EventConnection!
  streamEvents(streamId: ID!, first: Int, after: String): EventConnection!
  forecast(streamId: ID!, at: Int): Forecast
  webhookSubscriptions: [WebhookSubscription!]!
}
`.trim();

/**
 * Maps each scalar `Stream` field in the SDL to the key it reads on the
 * `Stream` projection (REST row). Relation / derived fields
 * (`senderAddress`, `recipientAddress`, `events`, `forecast`) are not raw
 * projection keys and are deliberately absent here.
 */
export const STREAM_FIELD_MAP: Record<string, string> = {
  id: "id",
  streamId: "streamId",
  sender: "sender",
  recipient: "recipient",
  token: "token",
  deposit: "deposit",
  withdrawn: "withdrawn",
  startTime: "startTime",
  endTime: "endTime",
  cancelable: "cancelable",
  status: "status",
  cancelledBy: "cancelled_by",
  recipientAmount: "recipient_amount",
  senderAmount: "sender_amount",
  refundTarget: "refund_target",
  lastLedger: "lastLedger",
  updatedAt: "updatedAt",
};

/** Field names of the `Stream` type, parsed out of the SDL. */
export function streamTypeFields(): string[] {
  const match = GRAPHQL_SDL.match(/type Stream \{([^}]*)\}/);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/[\s(:]/)[0]);
}
