import { NextResponse } from "next/server";
import {
  createVerificationChallenge,
  verifySignatureChallenge,
  checkRateLimit,
  defaultSubscriptionStore,
  defaultDispatcher,
  type NotificationChannelType,
  type SubscriptionConfig,
  type StreamEventType,
  type NotificationDigestOption,
  type StreamEvent,
} from "@/lib/notifications";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");

  if (!address) {
    return NextResponse.json({ error: "Missing address query parameter" }, { status: 400 });
  }

  const subscriptions = await defaultSubscriptionStore.getSubscriptionsForAddress(address);
  return NextResponse.json({ subscriptions });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "challenge") {
      const { address } = body;
      if (!address) {
        return NextResponse.json({ error: "Missing address parameter" }, { status: 400 });
      }

      if (!checkRateLimit(address, 20, 900)) {
        return NextResponse.json(
          { error: "Too many verification requests. Please try again later." },
          { status: 429 }
        );
      }

      const challenge = createVerificationChallenge(address);
      return NextResponse.json({ challenge });
    }

    if (action === "subscribe") {
      const {
        address,
        challengeText,
        signature,
        channel,
        config,
        eventTypes,
        digest,
      } = body as {
        address: string;
        challengeText: string;
        signature: string;
        channel: NotificationChannelType;
        config: SubscriptionConfig;
        eventTypes: StreamEventType[];
        digest?: NotificationDigestOption;
      };

      if (!address || !challengeText || !signature || !channel || !config) {
        return NextResponse.json(
          { error: "Missing required subscription parameters or signature verification data." },
          { status: 400 }
        );
      }

      // 1. Verify ed25519 signature & unexpired challenge
      const verification = verifySignatureChallenge(challengeText, signature, address);
      if (!verification.valid) {
        return NextResponse.json(
          { error: `Address verification failed: ${verification.reason}` },
          { status: 401 }
        );
      }

      // 2. Validate channel config
      if (channel === "webhook") {
        if (!config.webhook?.url || !config.webhook.url.startsWith("http")) {
          return NextResponse.json({ error: "Invalid webhook URL." }, { status: 400 });
        }
      } else if (channel === "email") {
        if (!config.email?.email || !config.email.email.includes("@")) {
          return NextResponse.json({ error: "Invalid destination email address." }, { status: 400 });
        }
      } else if (channel === "telegram") {
        if (!config.telegram?.chatId) {
          return NextResponse.json({ error: "Invalid Telegram chatId." }, { status: 400 });
        }
      }

      // 3. Register subscription
      const subscription = await defaultSubscriptionStore.addSubscription({
        address,
        channel,
        config,
        eventTypes: eventTypes || ["claim", "liveness", "cancel"],
        digest: digest || "instant",
      });

      return NextResponse.json({ subscription });
    }

    if (action === "test_dispatch") {
      const { subscriptionId, address } = body;
      const subs = await defaultSubscriptionStore.getSubscriptionsForAddress(address);
      const sub = subs.find((s) => s.id === subscriptionId);

      if (!sub) {
        return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
      }

      const testEvent: StreamEvent = {
        id: `evt_test_${Date.now()}`,
        type: "claim",
        address,
        timestamp: Math.floor(Date.now() / 1000),
        payload: {
          streamId: "demo-test",
          sender: address,
          recipient: address,
          token: "CAS3...DEMO",
          deposit: "10000000",
          amount: "500000",
          reason: "Manual test event dispatch verification",
        },
      };

      const result = await defaultDispatcher.dispatchStreamEvent(testEvent);
      return NextResponse.json({ result });
    }

    return NextResponse.json({ error: "Invalid action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const address = searchParams.get("address");

    if (!id || !address) {
      return NextResponse.json(
        { error: "Missing id or address query parameter" },
        { status: 400 }
      );
    }

    const removed = await defaultSubscriptionStore.removeSubscription(id, address);
    if (!removed) {
      return NextResponse.json(
        { error: "Subscription not found or unauthorized" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
