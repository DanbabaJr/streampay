/**
 * Shared story fixtures. Every value is a constant — no random ids, no
 * "now"-relative arithmetic outside FIXED_NOW_SECONDS — so a story renders the
 * same pixels on every machine and every run.
 */

import type { StreamPolicyView, StreamView } from "@/lib/stream-types";
import { FIXED_NOW_SECONDS } from "./fake-clock";

/** Well-formed (checksummed) keys derived from fixed seeds 0x01…0x04. */
export const SENDER = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
export const RECIPIENT = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";
export const BYSTANDER = "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG";
export const REFUND_TARGET = "GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP";

/** Testnet native XLM Stellar Asset Contract (lib/stellar.ts NATIVE_XLM_SAC). */
export const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
/** A non-native token contract id. */
export const TOKEN_CONTRACT = "CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L";

/** The streaming contract id Storybook pins (PINNED_PUBLIC_ENV in .storybook/main.ts). */
export const STREAMING_CONTRACT =
  "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";

const DAY = 86_400;

/** 30-day stream, started 10 days before the fixed clock: one third accrued. */
export const activeStream: StreamView = {
  id: "42",
  sender: SENDER,
  recipient: RECIPIENT,
  token: XLM_SAC,
  deposit: "30000000000",
  withdrawn: "4000000000",
  startTime: FIXED_NOW_SECONDS - 10 * DAY,
  endTime: FIXED_NOW_SECONDS + 20 * DAY,
  cancelable: true,
  status: "Active",
};

export const tokenStream: StreamView = {
  ...activeStream,
  id: "43",
  token: TOKEN_CONTRACT,
  deposit: "500000000",
  withdrawn: "0",
  cancelable: false,
};

export const cancelledStream: StreamView = {
  ...activeStream,
  id: "17",
  withdrawn: "10000000000",
  endTime: FIXED_NOW_SECONDS - 2 * DAY,
  status: "Cancelled",
};

export const completedStream: StreamView = {
  ...activeStream,
  id: "9",
  withdrawn: "30000000000",
  startTime: FIXED_NOW_SECONDS - 60 * DAY,
  endTime: FIXED_NOW_SECONDS - 30 * DAY,
  status: "Completed",
};

/** Contract-side `available` for `activeStream` at FIXED_NOW (deposit / 3 - withdrawn). */
export const ACTIVE_AVAILABLE = "6000000000";

export const openPolicy: StreamPolicyView = {
  minDeposit: "0",
  minDuration: 0,
  maxDuration: 0,
  minRate: "0",
  maxRate: "0",
};

export const strictPolicy: StreamPolicyView = {
  minDeposit: "10000000000",
  minDuration: 7 * DAY,
  maxDuration: 365 * DAY,
  minRate: "100",
  maxRate: "0",
};
