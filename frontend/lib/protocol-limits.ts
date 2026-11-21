/**
 * Contract protocol ceilings used by the frontend's client-side validation.
 *
 * Single frontend source of truth — `lib/batch.ts` used to carry its own
 * copy of `MAX_DURATION_SECONDS`, and every new literal is a value that can
 * drift from the contract. The values mirror
 * `contracts/streaming-payments/src/stream.rs` (`MAX_DURATION_SECONDS`,
 * `MIN_BATCH`/`MAX_BATCH`) via `sdks/spec/streampay.spec.json`, which is
 * what generates the SDK constants; `frontend/test/client-parity.test.ts`
 * asserts the three stay equal to the spec, so a contract change fails the
 * frontend suite instead of silently validating against a stale bound.
 */

export const MAX_DURATION_SECONDS = 3_155_760_000;
export const MAX_BATCH = 25;
export const MIN_BATCH = 1;
