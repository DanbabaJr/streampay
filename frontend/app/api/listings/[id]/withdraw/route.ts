import { NextRequest, NextResponse } from "next/server";
import { discoveryService } from "@/lib/discovery/service";
import { checkRateLimit } from "@/lib/discovery/rateLimit";
import type { ListingWithdrawPayload } from "@/lib/discovery/types";

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = getClientIp(req);
  const rateLimit = checkRateLimit(ip, 30, 60);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing listing ID" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const payload = body as Partial<ListingWithdrawPayload>;

  if (
    !payload.streamId ||
    !payload.nonce ||
    typeof payload.timestamp !== "number" ||
    !payload.signerAddress ||
    !payload.signature
  ) {
    return NextResponse.json(
      {
        error:
          "Missing or invalid withdrawal fields. Required: streamId, nonce, timestamp, signerAddress, signature.",
      },
      { status: 400 }
    );
  }

  const withdrawPayload: ListingWithdrawPayload = {
    listingId: id,
    streamId: payload.streamId,
    nonce: payload.nonce,
    timestamp: payload.timestamp,
    signerAddress: payload.signerAddress,
    signature: payload.signature,
  };

  const result = discoveryService.withdrawListing(withdrawPayload);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(
    {
      success: true,
      listingId: id,
      message: "Listing has been successfully withdrawn and unlisted.",
    },
    {
      status: 200,
      headers: {
        // Nonce replay protection is only as durable as the in-memory store (prototype-grade).
        "X-Discovery-Durability": "prototype-in-memory",
      },
    }
  );
}
