import type { Metadata } from "next";
import { notFound } from "next/navigation";
import RouteNotice from "@/components/RouteNotice";
import { isStellarAddress } from "@/lib/route-identity";
import {
  fetchAddressStreamsPage,
  fetchStreamsFor,
  type StreamView,
} from "@/lib/stellar";
import AddressExplorerClient, { type AddressStats } from "./AddressExplorerClient";
import { parseAddressExplorerUrlState } from "@/lib/address-explorer-url";

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

  // A malformed address cannot name an account; answer with a 400-style notice
  // instead of asking the chain and rendering an empty explorer.
  if (!isStellarAddress(addr)) {
    return <RouteNotice segment="address" status="bad-request" identifier={addr} />;
  }

  const sp = await searchParams;

  const state = parseAddressExplorerUrlState(sp);

  // Fetch paginated page for display
  const pageResult = await fetchAddressStreamsPage(addr, {
    cursor: state.cursor,
    direction: state.direction,
    limit: state.limit,
    role: state.tab,
    status: state.status,
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

  // A well-formed address with no history is an unknown entity; filtered empty
  // results still render the explorer so the user can clear the filters.
  if (
    stats.totalStreams === 0 &&
    state.tab === "all" &&
    state.status === "all" &&
    state.cursor === null
  ) {
    notFound();
  }

  return (
    <AddressExplorerClient
      address={addr}
      streams={pageResult.streams}
      asOfTimestamp={pageResult.asOfTimestamp}
      tab={state.tab}
      status={state.status}
      page={state.page}
      sort={state.sort}
      limit={state.limit}
      nextCursor={pageResult.nextCursor}
      prevCursor={pageResult.prevCursor}
      hasMore={pageResult.hasMore}
      hasPrev={pageResult.hasPrev}
      totalMatching={pageResult.totalMatching}
      stats={stats}
    />
  );
}
