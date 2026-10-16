import type { Metadata } from "next";
import {
  fetchAddressStreamsPage,
  fetchStreamsFor,
  type StreamRoleFilter,
  type StreamStatusFilter,
  type PaginationDirection,
  type StreamView,
} from "@/lib/stellar";
import AddressExplorerClient, { type AddressStats } from "./AddressExplorerClient";

interface AddressPageProps {
  params: Promise<{ addr: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({
  params,
}: AddressPageProps): Promise<Metadata> {
  const { addr } = await params;
  const shortAddr = addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr || "Address";

  return {
    title: `Address ${shortAddr} | StreamPay Explorer`,
    description: `Inspect real-time streaming payments, live token accruals, and transaction history for Stellar address ${addr}.`,
    alternates: {
      canonical: `/address/${addr}`,
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
      },
    },
    openGraph: {
      title: `StreamPay Explorer: ${shortAddr}`,
      description: `Live streaming payments, token deposits, and continuous accruals for ${shortAddr}`,
      url: `/address/${addr}`,
      siteName: "StreamPay",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: `StreamPay Explorer: ${shortAddr}`,
      description: `Live streaming payments and continuous accruals for ${shortAddr}`,
    },
  };
}

export default async function AddressPage({
  params,
  searchParams,
}: AddressPageProps) {
  const { addr } = await params;
  const sp = await searchParams;

  const rawTab = typeof sp.tab === "string" ? sp.tab : "all";
  const tab: StreamRoleFilter =
    rawTab === "incoming" || rawTab === "outgoing" ? rawTab : "all";

  const rawStatus = typeof sp.status === "string" ? sp.status : "all";
  const status: StreamStatusFilter =
    rawStatus === "active" || rawStatus === "ended" ? rawStatus : "all";

  const cursor = typeof sp.cursor === "string" ? sp.cursor : null;
  const dir: PaginationDirection =
    sp.dir === "backward" ? "backward" : "forward";

  const limitParam = typeof sp.limit === "string" ? parseInt(sp.limit, 10) : 10;
  const limit = isNaN(limitParam) ? 10 : Math.max(1, Math.min(limitParam, 50));

  // Fetch paginated page for display
  const pageResult = await fetchAddressStreamsPage(addr, {
    cursor,
    direction: dir,
    limit,
    role: tab,
    status,
  });

  // Calculate full account overview stats across both roles
  let allStreams: StreamView[] = [];
  try {
    const [recipientStreams, senderStreams] = await Promise.all([
      fetchStreamsFor(addr, "recipient").catch(() => []),
      fetchStreamsFor(addr, "sender").catch(() => []),
    ]);
    const byId = new Map<string, StreamView>();
    for (const s of [...recipientStreams, ...senderStreams]) {
      byId.set(s.id, s);
    }
    allStreams = [...byId.values()];
  } catch {
    allStreams = pageResult.streams;
  }

  const stats: AddressStats = {
    totalStreams: allStreams.length,
    activeStreams: allStreams.filter((s) => s.status === "Active").length,
    totalDeposited: allStreams.reduce(
      (sum, s) => sum + (BigInt(s.deposit) || 0n),
      0n
    ),
    totalWithdrawn: allStreams.reduce(
      (sum, s) => sum + (BigInt(s.withdrawn) || 0n),
      0n
    ),
  };

  return (
    <AddressExplorerClient
      address={addr}
      streams={pageResult.streams}
      asOfTimestamp={pageResult.asOfTimestamp}
      tab={tab}
      status={status}
      nextCursor={pageResult.nextCursor}
      prevCursor={pageResult.prevCursor}
      hasMore={pageResult.hasMore}
      hasPrev={pageResult.hasPrev}
      totalMatching={pageResult.totalMatching}
      stats={stats}
    />
  );
}
