/**
 * Persisted-query allowlist (#576).
 *
 * Only the queries in this map may run. The POST /graphql endpoint accepts
 * a `queryId` and variables — never ad-hoc query text — so the cost of
 * every runnable query is known up front, abusive ad-hoc queries cannot
 * reach the store, and the dashboard can only ask for the shapes below.
 *
 * To add a persisted query: add an entry here with a stable id and the
 * exact query text, keep it inside the depth/complexity limits (see
 * `executor.ts`: MAX_DEPTH / MAX_COMPLEXITY), and add a contract test in
 * `graphql.test.ts` asserting it matches the REST response for the same
 * fixture. Do not accept query text from clients.
 */
export const PERSISTED_QUERIES: Record<string, string> = {
  GetStream: `
    query GetStream($id: ID!) {
      stream(id: $id) {
        id streamId sender recipient token deposit withdrawn
        startTime endTime cancelable status cancelledBy
        recipientAmount senderAmount refundTarget lastLedger updatedAt
      }
    }`,
  GetStreamWithForecast: `
    query GetStreamWithForecast($id: ID!, $at: Int) {
      stream(id: $id) {
        id streamId sender recipient token deposit withdrawn status
        startTime endTime lastLedger updatedAt
        forecast(at: $at) {
          streamId accrued available projectedTotal ratePerSecond secondsRemaining asOf
        }
      }
    }`,
  GetStreamWithRelations: `
    query GetStreamWithRelations($id: ID!) {
      stream(id: $id) {
        id streamId status
        senderAddress { address streamCount }
        recipientAddress { address streamCount }
        events(first: 10) { totalCount pageInfo { hasNextPage nextCursor } edges { cursor node { id eventType ledger } } }
      }
    }`,
  GetStreamHistory: `
    query GetStreamHistory($streamId: ID!, $first: Int, $after: String) {
      streamHistory(streamId: $streamId, first: $first, after: $after) {
        totalCount pageInfo { hasNextPage nextCursor }
        edges { cursor node { id streamId eventType ledger ledgerClosedAt txHash payload } }
      }
    }`,
  GetStreamEvents: `
    query GetStreamEvents($streamId: ID!, $first: Int, $after: String) {
      streamEvents(streamId: $streamId, first: $first, after: $after) {
        totalCount pageInfo { hasNextPage nextCursor }
        edges { cursor node { id streamId eventType ledger seq payload } }
      }
    }`,
  GetStreamsByRecipient: `
    query GetStreamsByRecipient($recipient: String!, $first: Int, $after: String) {
      streamsByRecipient(recipient: $recipient, first: $first, after: $after) {
        totalCount pageInfo { hasNextPage nextCursor }
        edges { cursor node { id streamId sender recipient token deposit withdrawn status } }
      }
    }`,
  GetAddressStreams: `
    query GetAddressStreams($address: String!, $first: Int, $after: String) {
      address(address: $address) {
        address streamCount
        streams(first: $first, after: $after) {
          totalCount pageInfo { hasNextPage nextCursor }
          edges { cursor node { id streamId sender recipient status } }
        }
      }
    }`,
  GetForecast: `
    query GetForecast($streamId: ID!, $at: Int) {
      forecast(streamId: $streamId, at: $at) {
        streamId accrued available projectedTotal ratePerSecond secondsRemaining asOf
      }
    }`,
  ListWebhookSubscriptions: `
    query ListWebhookSubscriptions {
      webhookSubscriptions { id url events status createdAt updatedAt }
    }`,
};

export const PERSISTED_QUERY_IDS = Object.keys(PERSISTED_QUERIES);

export function getPersistedQuery(queryId: string): string | undefined {
  return PERSISTED_QUERIES[queryId];
}
