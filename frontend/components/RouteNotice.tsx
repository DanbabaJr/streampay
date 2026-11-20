/**
 * Shared terminal notice for the dynamic routes.
 *
 * `not-found` is rendered from the segment's not-found.tsx (404) and
 * `bad-request` directly from the page when the identifier is malformed (400).
 * The copy always says what was looked for, why it may be missing and what to
 * do next, so a dead link is not a blank screen.
 *
 * The pay segment keeps the claim surface's dark card so a broken invoice link
 * still looks like StreamPay; the other two use the app shell's card.
 */

import Link from "next/link";
import { resolveRequestLocale } from "@/lib/i18n/server";
import { makeFormatter } from "@/lib/i18n/format";
import type { MessageKey } from "@/lib/i18n/messages";

export type RouteSegment = "stream" | "address" | "pay";
export type RouteNoticeStatus = "not-found" | "bad-request";

interface RouteNoticeProps {
  segment: RouteSegment;
  status: RouteNoticeStatus;
  /** The offending identifier, echoed only on the malformed (400) branch. */
  identifier?: string;
}

function titleKey(segment: RouteSegment, status: RouteNoticeStatus): MessageKey {
  if (status === "bad-request") {
    return `notFound.${segment}.malformedTitle` as MessageKey;
  }
  return `notFound.${segment}.title` as MessageKey;
}

function bodyKey(segment: RouteSegment, status: RouteNoticeStatus): MessageKey {
  return status === "bad-request"
    ? (`notFound.${segment}.malformedBody` as MessageKey)
    : (`notFound.${segment}.why` as MessageKey);
}

export default async function RouteNotice({
  segment,
  status,
  identifier,
}: RouteNoticeProps) {
  const locale = await resolveRequestLocale();
  // The key is chosen at runtime from the segment/status pair, so the
  // compile-time argument tuple of `Formatter` cannot apply here.
  const t = makeFormatter(locale) as unknown as (
    key: MessageKey,
    params?: Record<string, unknown>
  ) => string;

  const title = t(titleKey(segment, status));
  const what = t(`notFound.${segment}.lookedFor` as MessageKey);
  const next = t(`notFound.${segment}.next` as MessageKey);
  const badge = t(
    status === "bad-request" ? "notFound.badRequest" : "notFound.notFound"
  );
  const back = t("chrome.backToDashboard");

  let body: string;
  if (status === "not-found") {
    body = t(bodyKey(segment, status));
  } else if (segment === "stream") {
    body = t("notFound.stream.malformedBody", { id: identifier ?? "" });
  } else if (segment === "address") {
    body = t("notFound.address.malformedBody", { address: identifier ?? "" });
  } else {
    body = t("notFound.pay.malformedBody");
  }

  if (segment === "pay") {
    return (
      <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
          <p className="text-xs uppercase tracking-wider font-semibold text-neutral-500 mb-3">
            {badge}
          </p>
          <h1 className="text-xl font-bold mb-2">{title}</h1>
          <p className="text-sm text-neutral-400 mb-2">{what}</p>
          <p className="text-sm text-neutral-300 mb-2">{body}</p>
          <p className="text-sm text-neutral-400 mb-6">{next}</p>
          <Link
            href="/"
            className="inline-block px-5 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-xl text-sm font-medium transition"
          >
            {back}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="wrap">
      <p className="kicker mono">{badge}</p>
      <h1>{title}</h1>
      <section className="card">
        <p className="muted">{what}</p>
        <p>{body}</p>
        <p className="muted">{next}</p>
        <p>
          <Link href="/">← {back}</Link>
        </p>
      </section>
    </main>
  );
}
