export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STELLAR_ADDRESS_REGEX = /^[GCB][A-Z2-7]{55}$/;

/**
 * Proxy SSE stream from indexer with visitor address scoping.
 * Enforces that visitors can only subscribe to event streams matching
 * their own authenticated / claimed address.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");
  const streamId = searchParams.get("streamId");
  const lastEventId = req.headers.get("last-event-id") ?? searchParams.get("lastEventId");

  // Auth scoping: address parameter is mandatory for visitor event scoping
  if (!address) {
    return new Response(
      JSON.stringify({ error: "Missing required 'address' query parameter for scoped stream events" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (!STELLAR_ADDRESS_REGEX.test(address)) {
    return new Response(
      JSON.stringify({ error: "Invalid Stellar address format" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (streamId && !/^\d+$/.test(streamId)) {
    return new Response(
      JSON.stringify({ error: "streamId must be an unsigned integer" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Verify auth header scoping if present (e.g. x-user-address or authorization)
  const headerUserAddress = req.headers.get("x-user-address");
  if (headerUserAddress && headerUserAddress !== address) {
    return new Response(
      JSON.stringify({ error: "Forbidden: address scope mismatch with authenticated user" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const indexerBaseUrl = process.env.INDEXER_URL || "http://localhost:8787";
  const upstreamUrl = new URL("/events/stream", indexerBaseUrl);
  upstreamUrl.searchParams.set("address", address);
  if (streamId) upstreamUrl.searchParams.set("streamId", streamId);
  if (lastEventId) upstreamUrl.searchParams.set("lastEventId", lastEventId);

  const upstreamHeaders: HeadersInit = {
    Accept: "text/event-stream",
  };
  if (lastEventId) {
    upstreamHeaders["Last-Event-ID"] = lastEventId;
  }

  try {
    const upstreamRes = await fetch(upstreamUrl.toString(), {
      headers: upstreamHeaders,
      signal: req.signal,
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      return new Response(
        JSON.stringify({
          error: "Indexer stream unavailable",
          status: upstreamRes.status,
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "5",
          },
        }
      );
    }

    // Stream indexer SSE to client with proxy-buffering disabling headers
    return new Response(upstreamRes.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    // If client aborted the connection, exit silently
    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    return new Response(
      JSON.stringify({
        error: "Failed to connect to indexer event feed",
        message: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "5",
        },
      }
    );
  }
}
