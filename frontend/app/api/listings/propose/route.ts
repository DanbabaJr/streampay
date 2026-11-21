import { NextRequest, NextResponse } from "next/server";
import { discoveryStore } from "@/lib/discovery/store";
import { checkRateLimit } from "@/lib/discovery/rateLimit";
import { verifyPartyConsent } from "@/lib/discovery/crypto";
import {
  getDefaultNetwork,
  getDefaultContractId,
} from "@/lib/discovery/service";
import { readStream } from "@/lib/stellar";

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rateLimit = checkRateLimit(ip, 60, 60);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const streamId = searchParams.get("streamId");
  if (!streamId) {
    return NextResponse.json({ error: "Missing streamId" }, { status: 400 });
  }

  const proposal = discoveryStore.getProposal(streamId);
  if (!proposal) {
    return NextResponse.json({ proposal: null }, { status: 200 });
  }

  // Check if expired
  const now = Math.floor(Date.now() / 1000);
  if (proposal.expiry <= now) {
    return NextResponse.json({ proposal: null }, { status: 200 });
  }

  return NextResponse.json(
    { proposal },
    {
      status: 200,
      headers: {
        // Nonce replay protection is only as durable as the in-memory store (prototype-grade).
        "X-Discovery-Durability": "prototype-in-memory",
      },
    }
  );
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rateLimit = checkRateLimit(ip, 30, 60);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = body as {
    streamId: string;
    nonce: string;
    expiry: number;
    initiatorConsent: {
      address: string;
      signature: string;
      shareAddress: boolean;
    };
  };

  if (
    !payload.streamId ||
    !payload.nonce ||
    !payload.expiry ||
    !payload.initiatorConsent ||
    !payload.initiatorConsent.address ||
    !payload.initiatorConsent.signature
  ) {
    return NextResponse.json(
      { error: "Invalid proposal payload" },
      { status: 400 }
    );
  }

  // Verify on-chain stream exists and signer is either sender or recipient
  let stream;
  try {
    stream = await readStream(payload.streamId);
  } catch {
    return NextResponse.json(
      { error: "Stream not found on chain" },
      { status: 404 }
    );
  }

  const isSender = payload.initiatorConsent.address === stream.sender;
  const isRecipient = payload.initiatorConsent.address === stream.recipient;

  if (!isSender && !isRecipient) {
    return NextResponse.json(
      { error: "Signer must be stream sender or recipient" },
      { status: 403 }
    );
  }

  const verifyRes = verifyPartyConsent({
    expectedSigner: payload.initiatorConsent.address,
    expectedNetwork: getDefaultNetwork(),
    expectedContractId: getDefaultContractId(),
    expectedStreamId: payload.streamId,
    nonce: payload.nonce,
    expiry: payload.expiry,
    partyConsent: payload.initiatorConsent,
  });

  if (!verifyRes.valid) {
    return NextResponse.json(
      { error: `Invalid signature: ${verifyRes.error}` },
      { status: 400 }
    );
  }

  discoveryStore.saveProposal(payload.streamId, payload);

  return NextResponse.json(
    { success: true, message: "Proposal saved for counterparty co-signature" },
    {
      status: 201,
      headers: {
        // Nonce replay protection is only as durable as the in-memory store (prototype-grade).
        "X-Discovery-Durability": "prototype-in-memory",
      },
    }
  );
}
