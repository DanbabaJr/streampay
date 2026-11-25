import { NextRequest, NextResponse } from "next/server";
import { discoveryService } from "@/lib/discovery/service";
import { checkRateLimit } from "@/lib/discovery/rateLimit";

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = getClientIp(req);
  const rateLimit = checkRateLimit(ip, 120, 60);

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

  const listing = discoveryService.getListingById(id);
  if (!listing) {
    return NextResponse.json(
      { error: "Listing not found or has been withdrawn" },
      { status: 404 }
    );
  }

  return NextResponse.json(listing, {
    status: 200,
    headers: {
      "X-RateLimit-Remaining": String(rateLimit.remaining),
      "X-RateLimit-Reset": String(rateLimit.reset),
      // Nonce replay protection is only as durable as the in-memory store (prototype-grade).
      "X-Discovery-Durability": "prototype-in-memory",
    },
  });
}
