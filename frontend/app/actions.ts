"use server";

import {
  fetchStreamIdsPage,
  readAvailable,
  readRefundTarget,
  readStream,
  readStreamPolicy,
} from "@/lib/stellar-read";
import {
  decodePaymentLinkRef,
  encodePaymentLinkRef,
  PaymentLinkData,
} from "@/lib/payment-link";
import type { StreamView } from "@/lib/stream-types";

export async function readStreamAction(streamId: string) {
  return readStream(streamId);
}

export async function readAvailableAction(streamId: string) {
  return (await readAvailable(streamId)).toString();
}

export async function readRefundTargetAction(streamId: string) {
  return readRefundTarget(streamId);
}

export async function fetchStreamIdsPageAction(
  address: string,
  role: "recipient" | "sender",
  offset: number
) {
  return fetchStreamIdsPage(address, role, offset);
}

export async function readStreamPolicyAction(token?: string) {
  return readStreamPolicy(token);
}

export interface PaymentLinkResolution {
  valid: boolean;
  error?: string;
  decoded?: PaymentLinkData;
  stream?: StreamView;
  available?: string;
}

export async function readPaymentLinkAction(
  ref: string
): Promise<PaymentLinkResolution> {
  const decoded = await decodePaymentLinkRef(ref);
  if (!decoded) {
    return {
      valid: false,
      error: "Malformed, invalid, or corrupted payment link reference.",
    };
  }

  try {
    const stream = await readStream(decoded.streamId);
    let available = "0";
    try {
      const availBigInt = await readAvailable(decoded.streamId);
      available = availBigInt.toString();
    } catch {
      available = "0";
    }

    return {
      valid: true,
      decoded,
      stream,
      available,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      decoded,
      error: `Could not resolve stream #${decoded.streamId} on-chain: ${message}`,
    };
  }
}

export async function createPaymentLinkAction(
  streamId: string,
  recipient: string
): Promise<string> {
  return encodePaymentLinkRef({
    streamId,
    recipient,
  });
}