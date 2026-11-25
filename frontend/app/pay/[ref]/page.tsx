import { notFound } from "next/navigation";
import { readPaymentLinkAction } from "@/app/actions";
import RouteNotice from "@/components/RouteNotice";
import PaymentLinkClient from "./PaymentLinkClient";

export default async function PaymentLinkPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  const { ref } = await params;
  const resolution = await readPaymentLinkAction(ref);

  // A reference that does not decode was never a link; a decoded reference
  // whose stream is absent is indistinguishable from one that never existed,
  // so both the 404 page and its metadata stay deliberately generic.
  if (!resolution.decoded) {
    return <RouteNotice segment="pay" status="bad-request" />;
  }
  if (!resolution.stream) notFound();

  return <PaymentLinkClient refValue={ref} initialResolution={resolution} />;
}
