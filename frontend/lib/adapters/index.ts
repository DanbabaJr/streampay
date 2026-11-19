/**
 * Adapter factory — returns the concrete WalletAdapter for a given WalletId.
 *
 * Adapters are instantiated on demand (not as singletons) so that each
 * connect / disconnect cycle is independent.  The WalletContext (see
 * wallet-context.tsx) holds the active instance.
 */

import type { WalletAdapter, WalletId } from "../wallet-adapter";

export async function createAdapter(id: WalletId): Promise<WalletAdapter> {
  switch (id) {
    case "freighter": {
      const { FreighterAdapter } = await import("./freighter.ts");
      return new FreighterAdapter();
    }
    case "albedo": {
      const { AlbedoAdapter } = await import("./albedo.ts");
      return new AlbedoAdapter();
    }
    default: {
      // TypeScript exhaustiveness check.
      const _exhaustive: never = id;
      throw new Error(`Unknown wallet id: ${String(_exhaustive)}`);
    }
  }
}
