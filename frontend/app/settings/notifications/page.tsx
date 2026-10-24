"use client";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import { isConnected, requestAccess, signMessage } from "@stellar/freighter-api";
import { checkWalletNetwork } from "@/lib/network";
import type {
  Subscription,
  NotificationChannelType,
  StreamEventType,
  NotificationDigestOption,
} from "@/lib/notifications/types";

export default function NotificationsSettingsPage() {
  const [address, setAddress] = useState<string | null>(null);
  const [challengeText, setChallengeText] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  // Form states
  const [channel, setChannel] = useState<NotificationChannelType>("webhook");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<StreamEventType[]>([
    "claim",
    "liveness",
    "cancel",
  ]);
  const [digest, setDigest] = useState<NotificationDigestOption>("instant");

  const loadSubscriptions = useCallback(async (addr: string) => {
    try {
      const res = await fetch(`/api/notifications?address=${addr}`);
      if (res.ok) {
        const data = await res.json();
        setSubscriptions(data.subscriptions || []);
      }
    } catch {
      // Ignore network errors on background poll
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { isConnected: connected } = await isConnected();
        if (connected) {
          const { address } = await requestAccess();
          if (address) {
            setAddress(address);
            void loadSubscriptions(address);
          }
        }
      } catch {
        // Read-only until wallet connected
      }
    })();
  }, [loadSubscriptions]);

  async function connectWallet() {
    setErrorMsg("");
    try {
      const { isConnected: connected } = await isConnected();
      if (!connected) {
        setErrorMsg("Freighter wallet extension not found. Please install Freighter.");
        return;
      }
      const { address: addr, error } = await requestAccess();
      if (error || !addr) {
        setErrorMsg(error?.message || "Failed to retrieve address from wallet.");
        return;
      }
      setAddress(addr);
      await checkWalletNetwork();
      setStatusMsg(`Connected as ${addr.slice(0, 6)}…${addr.slice(-6)}`);
      await loadSubscriptions(addr);
    } catch (e) {
      setErrorMsg(`Wallet connection error: ${String(e)}`);
    }
  }

  async function requestAndSignChallenge() {
    if (!address) return;
    setErrorMsg("");
    setStatusMsg("Requesting verification challenge from server…");
    setLoading(true);

    try {
      // 1. Get challenge
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "challenge", address }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || "Failed to obtain challenge.");
        setLoading(false);
        return;
      }

      const challenge = data.challenge.message;
      setChallengeText(challenge);
      setStatusMsg("Signing challenge in Freighter extension…");

      // 2. Sign with Freighter
      const signRes = await signMessage(challenge, { address });
      if (signRes.error || !signRes.signedMessage) {
        setErrorMsg(signRes.error?.message || "Signature request was rejected by user.");
        setLoading(false);
        return;
      }

      // Convert buffer or string to base64
      let sigStr = "";
      if (typeof signRes.signedMessage === "string") {
        sigStr = signRes.signedMessage;
      } else if (signRes.signedMessage instanceof Uint8Array || Buffer.isBuffer(signRes.signedMessage)) {
        sigStr = Buffer.from(signRes.signedMessage).toString("base64");
      }

      setSignature(sigStr);
      setStatusMsg("✓ Address ownership verified with ed25519 signature!");
    } catch (e) {
      setErrorMsg(`Signature failed: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubscribe(e: React.FormEvent) {
    e.preventDefault();
    if (!address) {
      setErrorMsg("Please connect your wallet first.");
      return;
    }
    if (!challengeText || !signature) {
      setErrorMsg("Please sign the address verification challenge before subscribing.");
      return;
    }

    setErrorMsg("");
    setStatusMsg("Registering notification subscription…");
    setLoading(true);

    const config = {
      ...(channel === "webhook" ? { webhook: { url: webhookUrl, secret: webhookSecret } } : {}),
      ...(channel === "email" ? { email: { email: emailAddress, digest } } : {}),
      ...(channel === "telegram" ? { telegram: { chatId: telegramChatId } } : {}),
    };

    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "subscribe",
          address,
          challengeText,
          signature,
          channel,
          config,
          eventTypes: selectedEvents,
          digest,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || "Subscription registration failed.");
      } else {
        setStatusMsg("✓ Subscription registered successfully!");
        setWebhookUrl("");
        setWebhookSecret("");
        setEmailAddress("");
        setTelegramChatId("");
        await loadSubscriptions(address);
      }
    } catch (err) {
      setErrorMsg(`Subscription error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!address) return;
    try {
      const res = await fetch(`/api/notifications?id=${id}&address=${address}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setStatusMsg("Subscription removed.");
        await loadSubscriptions(address);
      }
    } catch (err) {
      setErrorMsg(`Delete failed: ${String(err)}`);
    }
  }

  async function handleTestDispatch(id: string) {
    if (!address) return;
    setStatusMsg("Dispatching test notification…");
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test_dispatch", address, subscriptionId: id }),
      });
      const data = await res.json();
      if (res.ok && data.result.successCount > 0) {
        setStatusMsg("✓ Test notification delivered successfully!");
      } else {
        setErrorMsg(`Test delivery failed. Result: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      setErrorMsg(`Test dispatch error: ${String(err)}`);
    }
  }

  function toggleEvent(evt: StreamEventType) {
    setSelectedEvents((prev) =>
      prev.includes(evt) ? prev.filter((x) => x !== evt) : [...prev, evt]
    );
  }

  return (
    <main className="wrap">
      <div style={{ marginBottom: 16 }}>
        <Link href="/" style={{ fontSize: 13, color: "var(--muted)" }}>
          ← Back to StreamPay
        </Link>
      </div>

      <header style={{ marginBottom: 24 }}>
        <h1>Notification Channels</h1>
        <p className="muted">
          Subscribe to real-time event notifications for payment withdrawals (claim),
          storage expiration warnings (liveness), and stream cancellations.
        </p>
      </header>

      {statusMsg ? <div className="ok" style={{ marginBottom: 16 }}>{statusMsg}</div> : null}
      {errorMsg ? <div className="err" style={{ marginBottom: 16 }}>{errorMsg}</div> : null}

      {/* Wallet & Abuse Verification Section */}
      <section className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, margin: "0 0 12px 0" }}>1. Account Verification</h2>
        {!address ? (
          <div>
            <p className="muted">Connect your Stellar wallet to manage alert channels.</p>
            <button type="button" onClick={connectWallet}>
              Connect Freighter Wallet
            </button>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
              <span className="mono" style={{ fontSize: 14 }}>{address}</span>
              <span
                className="badge-pill"
                style={{
                  background: signature ? "rgba(61,220,132,0.15)" : "rgba(245,158,11,0.15)",
                  color: signature ? "var(--green)" : "var(--amber)",
                }}
              >
                {signature ? "✓ Verified Owner" : "Signature Required"}
              </span>
            </div>

            {!signature ? (
              <div>
                <p className="muted" style={{ fontSize: 13 }}>
                  Abuse Control: You must prove ownership of this Stellar account with a cryptographic
                  message signature before creating webhooks or email alerts.
                </p>
                <button
                  type="button"
                  onClick={requestAndSignChallenge}
                  disabled={loading}
                >
                  {loading ? "Signing…" : "Sign Verification Challenge"}
                </button>
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 12 }}>
                Cryptographic signature active. You can register notification channels below.
              </p>
            )}
          </div>
        )}
      </section>

      {/* Subscription Creation Form */}
      {address && signature ? (
        <section className="card" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 16px 0" }}>2. Register New Channel</h2>
          <form onSubmit={handleSubscribe}>
            <label htmlFor="channel-select">Channel Type</label>
            <select
              id="channel-select"
              value={channel}
              onChange={(e) => setChannel(e.target.value as NotificationChannelType)}
            >
              <option value="webhook">Webhook (HTTP POST with HMAC)</option>
              <option value="email">Email (Transactional Alert / Digest)</option>
              <option value="telegram">Telegram Bot Alert</option>
            </select>

            {channel === "webhook" ? (
              <>
                <label htmlFor="webhook-url">Endpoint URL</label>
                <input
                  id="webhook-url"
                  type="text"
                  placeholder="https://api.yourdomain.com/webhooks/streampay"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  required
                />

                <label htmlFor="webhook-secret">HMAC Secret (optional, for signature verification)</label>
                <input
                  id="webhook-secret"
                  type="text"
                  placeholder="whsec_abc123..."
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                />
              </>
            ) : null}

            {channel === "email" ? (
              <>
                <label htmlFor="email-addr">Destination Email</label>
                <input
                  id="email-addr"
                  type="text"
                  placeholder="you@domain.com"
                  value={emailAddress}
                  onChange={(e) => setEmailAddress(e.target.value)}
                  required
                />
              </>
            ) : null}

            {channel === "telegram" ? (
              <>
                <label htmlFor="telegram-chat">Telegram Chat ID</label>
                <input
                  id="telegram-chat"
                  type="text"
                  placeholder="123456789"
                  value={telegramChatId}
                  onChange={(e) => setTelegramChatId(e.target.value)}
                  required
                />
              </>
            ) : null}

            <label>Events to Monitor</label>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "8px 0" }}>
              <label style={{ textTransform: "none", display: "inline-flex", alignItems: "center", gap: 6, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={selectedEvents.includes("claim")}
                  onChange={() => toggleEvent("claim")}
                />
                Withdrawals / Claims
              </label>
              <label style={{ textTransform: "none", display: "inline-flex", alignItems: "center", gap: 6, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={selectedEvents.includes("liveness")}
                  onChange={() => toggleEvent("liveness")}
                />
                Liveness (TTL Cliff Warnings)
              </label>
              <label style={{ textTransform: "none", display: "inline-flex", alignItems: "center", gap: 6, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={selectedEvents.includes("cancel")}
                  onChange={() => toggleEvent("cancel")}
                />
                Cancellations
              </label>
            </div>

            <label htmlFor="digest-select">Frequency / Digest</label>
            <select
              id="digest-select"
              value={digest}
              onChange={(e) => setDigest(e.target.value as NotificationDigestOption)}
            >
              <option value="instant">Instant (Per Event)</option>
              <option value="daily_digest">Daily Digest</option>
            </select>

            <button type="submit" disabled={loading}>
              {loading ? "Registering…" : "Register Channel"}
            </button>
          </form>
        </section>
      ) : null}

      {/* Active Subscriptions List */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 18, margin: "0 0 14px 0" }}>Active Subscriptions</h2>
        {subscriptions.length === 0 ? (
          <div className="card" style={{ textAlign: "center", padding: "32px 16px" }}>
            <p className="muted" style={{ margin: 0 }}>
              No notification channels registered for this address yet.
            </p>
          </div>
        ) : (
          <div>
            {subscriptions.map((sub) => (
              <div key={sub.id} className="stream-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span className="mono" style={{ fontWeight: 700, fontSize: 15, textTransform: "uppercase" }}>
                      {sub.channel}
                    </span>
                    <span
                      className="status-badge"
                      style={{
                        background:
                          sub.status === "active"
                            ? "rgba(61,220,132,0.15)"
                            : sub.status === "bounced"
                            ? "rgba(255,107,107,0.15)"
                            : "rgba(245,158,11,0.15)",
                        color:
                          sub.status === "active"
                            ? "var(--green)"
                            : sub.status === "bounced"
                            ? "var(--red)"
                            : "var(--amber)",
                      }}
                    >
                      {sub.status}
                    </span>
                  </div>

                  <div className="mono muted" style={{ fontSize: 13, marginBottom: 4 }}>
                    {sub.channel === "webhook" ? sub.config.webhook?.url : null}
                    {sub.channel === "email" ? sub.config.email?.email : null}
                    {sub.channel === "telegram" ? `Chat ID: ${sub.config.telegram?.chatId}` : null}
                  </div>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {sub.eventTypes.map((t) => (
                      <span key={t} className="badge-pill" style={{ background: "rgba(255,255,255,0.06)", color: "var(--text)" }}>
                        {t}
                      </span>
                    ))}
                  </div>

                  {sub.bounceReason ? (
                    <div className="err" style={{ fontSize: 11, marginTop: 4 }}>
                      Bounce / Failure reason: {sub.bounceReason}
                    </div>
                  ) : null}
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="page-btn"
                    style={{ margin: 0, padding: "6px 12px" }}
                    onClick={() => handleTestDispatch(sub.id)}
                  >
                    Test Send
                  </button>
                  <button
                    type="button"
                    className="page-btn"
                    style={{ margin: 0, padding: "6px 12px", color: "var(--red)", borderColor: "rgba(255,107,107,0.3)" }}
                    onClick={() => handleDelete(sub.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Architecture & Delivery Guarantee Callout */}
      <aside
        style={{
          background: "rgba(139, 124, 255, 0.05)",
          border: "1px solid rgba(139, 124, 255, 0.2)",
          borderRadius: 8,
          padding: "16px 20px",
          fontSize: 13,
          color: "var(--muted)",
          lineHeight: 1.6,
        }}
      >
        <h3 style={{ color: "var(--text)", fontSize: 14, margin: "0 0 8px 0" }}>
          Delivery Guarantees & Security Model
        </h3>
        <ul style={{ margin: "0 0 8px 0", paddingLeft: 20 }}>
          <li>
            <strong>At-Least-Once Delivery:</strong> Notifications carry unique <code>Idempotency-Key</code>
            headers (e.g. <code>evt_123:sub_456</code>) so downstream sinks can deduplicate retries safely.
          </li>
          <li>
            <strong>HMAC Request Authentication:</strong> Webhooks include an <code>X-StreamPay-Signature</code>
            header computed with HMAC-SHA256 over timestamp and JSON body.
          </li>
          <li>
            <strong>Exponential Backoff:</strong> Failures are retried using <code>delay(n) = min(32s, 1s * 2^n) +/- 20% jitter</code>
            across 5 attempts before marking channel as paused.
          </li>
          <li>
            <strong>Bounce & Abuse Handling:</strong> Hard email bounces immediately pause deliveries. Subscriptions
            require proof of address ownership through Freighter ed25519 signature challenges.
          </li>
        </ul>
      </aside>
    </main>
  );
}
