import { notFound } from "next/navigation";
import { readStreamOptional } from "@/lib/stellar-read";
import { resolveStream } from "@/lib/route-identity";
import RouteNotice from "@/components/RouteNotice";
import StreamDetailClient from "./StreamDetailClient";

export default async function StreamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const resolved = await resolveStream(id, readStreamOptional);

  if (resolved.status === "malformed") {
    return <RouteNotice segment="stream" status="bad-request" identifier={id} />;
  }
  if (resolved.status === "missing") notFound();

  return <StreamDetailClient />;
}
