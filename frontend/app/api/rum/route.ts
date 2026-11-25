import { killSwitchOn } from "@/lib/rum/config";
import { handleIngest } from "@/lib/rum/ingest";
import { limiter, sink } from "@/lib/rum/sink";

export const dynamic = "force-dynamic";

// POST: ingest one vital. 410 when the kill switch is on (clients then stop).
export async function POST(req: Request): Promise<Response> {
  // The rate-limit key lives in memory for the window only and is never stored with samples.
  const key = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const status = handleIngest(
    await req.text(),
    key,
    { killSwitch: process.env.RUM_KILL_SWITCH },
    limiter,
    sink,
  );
  return new Response(null, { status });
}

// GET: aggregated percentiles for the dashboard panel.
export async function GET(): Promise<Response> {
  return Response.json({
    enabled: !killSwitchOn(process.env.RUM_KILL_SWITCH),
    summary: sink.summary(),
  });
}
