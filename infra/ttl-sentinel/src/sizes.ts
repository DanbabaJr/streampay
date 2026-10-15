//! Entry sizes, measured from XDR fixtures that mirror the contract's stored
//! values (see `test/sizes.test.ts`, which re-derives them from the live SDK
//! encoding and fails if the contract's field set changes).
//!
//! Rent is charged on entry size, so a wrong size is a wrong cost table.
//! Measured `LedgerEntryData` byte lengths (fixed width regardless of the
//! values stored — `deposit`/`withdrawn` are always `i128`):
//! - `Stream` entry: 504 B (10-field ScMap + `DataKey::Stream(u64)` key)
//! - index entry: 136 B + 12 B per indexed id (`Vec<u64>`)
//! - counter entry: 92 B
//! - instance entry: 96 B (empty instance storage; grows with contract state)
//! - Wasm code entry: the Wasm byte length itself (hundreds of KB), rent ÷ 3

import type { EntryClass } from './cliff.js';

export const MEASURED_ENTRY_BYTES: Record<EntryClass, number> = {
  stream: 504,
  index: 148, // one indexed id
  counter: 92,
  instance: 96,
  code: 120_000, // placeholder until the scanner measures the deployed Wasm
};

/** Index entries are `136 + 12 × ids` bytes (measured linear fit). */
export function estimateIndexBytes(ids: number): number {
  return 136 + 12 * Math.max(0, ids);
}

export function estimatedSizes(opts: { indexesPerAddressIds?: number } = {}): Record<EntryClass, number> {
  return {
    ...MEASURED_ENTRY_BYTES,
    index: estimateIndexBytes(opts.indexesPerAddressIds ?? 1),
  };
}
