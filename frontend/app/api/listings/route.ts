import { NextRequest, NextResponse } from "next/server";
import { discoveryService } from "@/lib/discovery/service";
import { checkRateLimit } from "@/lib/discovery/rateLimit";
import type {
  ListingQueryParams,
  ListingSubmissionPayload,
  RateBucket,
  DurationBucket,
  ListingStatus,
} from "@/lib/discovery/types";

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rateLimit = checkRateLimit(ip, 120, 60);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.reset - Math.floor(Date.now() / 1000)),
        },
      }
    );
  }

  const { searchParams } = new URL(req.url);

  const params: ListingQueryParams = {
    asset: searchParams.get("asset") || undefined,
    rateBucket: (searchParams.get("rateBucket") as RateBucket) || undefined,
    durationBucket: (searchParams.get("durationBucket") as DurationBucket) || undefined,
    status: (searchParams.get("status") as ListingStatus) || undefined,
    includeLowAnonymity: searchParams.get("includeLowAnonymity") === "true",
    page: searchParams.get("page") ? parseInt(searchParams.get("page")!, 10) : 1,
    limit: searchParams.get("limit") ? parseInt(searchParams.get("limit")!, 10) : 20,
  };

  const result = discoveryService.queryListings(params);

  return NextResponse.json(result, {
    status: 200,
    headers: {
      "X-RateLimit-Remaining": String(rateLimit.remaining),
      "X-RateLimit-Reset": String(rateLimit.reset),
      // Nonce replay protection is only as durable as the in-memory store (prototype-grade).
      "X-Discovery-Durability": "prototype-in-memory",
    },
  });
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rateLimit = checkRateLimit(ip, 30, 60);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const payload = body as Partial<ListingSubmissionPayload>;

  if (
    !payload.streamId ||
    !payload.nonce ||
    typeof payload.expiry !== "number" ||
    !payload.senderConsent ||
    !payload.recipientConsent ||
    !payload.senderConsent.address ||
    !payload.senderConsent.signature ||
    !payload.recipientConsent.address ||
    !payload.recipientConsent.signature
  ) {
    return NextResponse.json(
      {
        error:
          "Missing or invalid submission fields. Both sender and recipient consent signatures are required.",
      },
      { status: 400 }
    );
  }

  const result = await discoveryService.submitListing(payload as ListingSubmissionPayload);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result.listing, {
    status: 201,
    headers: {
      // Nonce replay protection is only as durable as the in-memory store (prototype-grade).
      "X-Discovery-Durability": "prototype-in-memory",
    },
  });
}
