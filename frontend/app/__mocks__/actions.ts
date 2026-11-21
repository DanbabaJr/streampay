/**
 * Storybook replacement for `app/actions.ts` (registered with `sb.mock` in
 * .storybook/preview.tsx; never imported by the app).
 *
 * The real module is a `"use server"` boundary over `lib/stellar-read.ts`,
 * which imports `server-only` and throws the moment a browser bundle loads it.
 * Automocking would still evaluate the original, so this file stands in for it
 * entirely. Each export is a `fn()` spy: the preview gives every action a
 * deterministic default in `beforeEach`, and a story overrides the one it is
 * about with `mocked(readStreamAction).mockResolvedValue(...)`.
 *
 * `__mocks__` is a private folder to the App Router (leading underscore), so
 * Next never turns it into a route.
 */

import { fn } from "storybook/test";
import type * as actual from "../actions";

export type { PaymentLinkResolution } from "../actions";

export const readStreamAction = fn<typeof actual.readStreamAction>();
export const readAvailableAction = fn<typeof actual.readAvailableAction>();
export const readRefundTargetAction = fn<typeof actual.readRefundTargetAction>();
export const fetchStreamIdsPageAction = fn<typeof actual.fetchStreamIdsPageAction>();
export const readStreamPolicyAction = fn<typeof actual.readStreamPolicyAction>();
export const readPaymentLinkAction = fn<typeof actual.readPaymentLinkAction>();
export const createPaymentLinkAction = fn<typeof actual.createPaymentLinkAction>();
