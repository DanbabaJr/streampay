/**
 * Storybook replacement for `lib/discovery/service.ts` (registered with
 * `sb.mock` in .storybook/preview.tsx; never imported by the app).
 *
 * The real service imports `node:crypto` for its HMAC attestations, which the
 * Vite browser bundle cannot load. `DiscoveryConsentModal` only reads the two
 * network defaults from it, so those are all this stand-in provides; any other
 * export a component starts importing fails the Storybook build loudly instead
 * of silently pulling the server code into the browser.
 */

import { Networks } from "@stellar/stellar-sdk";
import type * as actual from "../service";

export const getDefaultNetwork: typeof actual.getDefaultNetwork = () =>
  Networks.TESTNET;

export const getDefaultContractId: typeof actual.getDefaultContractId = () =>
  process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID ||
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
