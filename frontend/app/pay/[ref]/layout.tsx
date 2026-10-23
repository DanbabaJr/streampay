import type { Metadata } from "next";
import { readPaymentLinkAction } from "@/app/actions";
import { formatMessage } from "@/lib/i18n/format";
import { resolveRequestLocale } from "@/lib/i18n/server";
import { formatStroops } from "@/lib/i18n/amounts";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ ref: string }>;
}): Promise<Metadata> {
  const { ref } = await params;
  // Social-preview copy is the one place the locale is read here rather than in
  // the page: the metadata *is* the first render a sharing recipient sees.
  const locale = await resolveRequestLocale();
  const resolution = await readPaymentLinkAction(ref);

  if (!resolution.valid || !resolution.stream) {
    return {
      title: formatMessage(locale, "meta.pay.notFound.title"),
      description: formatMessage(locale, "meta.pay.notFound.description"),
      openGraph: {
        title: formatMessage(locale, "meta.pay.notFound.ogTitle"),
        description: formatMessage(locale, "meta.pay.notFound.ogDescription"),
      },
    };
  }

  const { stream } = resolution;
  // Display copy for a link preview, so the fraction is capped; the on-chain
  // value is never re-derived from this string.
  const depositFormatted = formatStroops(stream.deposit, locale, { maxFractionDigits: 4 });
  const unit = formatMessage(locale, "pay.invoice.unit.tokens");
  const status = stream.status.toLowerCase();

  const statusText =
    status === "cancelled"
      ? formatMessage(locale, "meta.pay.status.cancelled")
      : status === "depleted"
      ? formatMessage(locale, "meta.pay.status.depleted")
      : Date.now() / 1000 > stream.endTime
      ? formatMessage(locale, "meta.pay.status.completed")
      : formatMessage(locale, "meta.pay.status.active");

  const title = formatMessage(locale, "meta.pay.title", {
    status: statusText,
    amount: depositFormatted,
    unit,
    brand: formatMessage(locale, "brand.name"),
  });
  const description = formatMessage(locale, "meta.pay.description", {
    amount: depositFormatted,
    unit,
  });

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      siteName: formatMessage(locale, "brand.name"),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default function PayLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
