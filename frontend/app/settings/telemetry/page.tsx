"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import SettingsNav from "@/components/SettingsNav";
import { useT } from "@/lib/i18n/provider";
import {
  loadTelemetryConsent,
  saveTelemetryConsent,
  subscribeTelemetryConsent,
} from "@/lib/storage";

export default function TelemetrySettingsPage() {
  const t = useT();
  const enabled = useSyncExternalStore(
    subscribeTelemetryConsent,
    loadTelemetryConsent,
    () => true
  );

  function updateConsent(nextEnabled: boolean) {
    saveTelemetryConsent(nextEnabled);
  }

  return (
    <main className="wrap">
      <div style={{ marginBottom: 16 }}>
        <Link href="/" style={{ fontSize: 13, color: "var(--muted)" }}>
          ← {t("chrome.backToDashboard")}
        </Link>
      </div>
      <SettingsNav />

      <header style={{ margin: "20px 0" }}>
        <h1>{t("telemetry.title")}</h1>
        <p className="muted">{t("telemetry.description")}</p>
        <p className="muted">{t("telemetry.scope")}</p>
      </header>

      <section className="card" aria-labelledby="telemetry-consent-title" style={{ marginBottom: 20 }}>
        <h2 id="telemetry-consent-title" style={{ marginTop: 0 }}>
          {t(enabled ? "telemetry.statusEnabled" : "telemetry.statusDisabled")}
        </h2>
        <label style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => updateConsent(event.target.checked)}
            aria-describedby="telemetry-toggle-help"
          />
          <span>{t("telemetry.toggleLabel")}</span>
        </label>
        <p id="telemetry-toggle-help" className="muted" style={{ marginBottom: 0 }}>
          {t("telemetry.toggleHelp")}
        </p>
      </section>

      <section className="card" aria-labelledby="telemetry-collected-title">
        <h2 id="telemetry-collected-title" style={{ marginTop: 0 }}>
          {t("telemetry.collectedTitle")}
        </h2>
        <ul style={{ paddingLeft: 22, lineHeight: 1.7 }}>
          <li>{t("telemetry.spans")}</li>
          <li>{t("telemetry.correlation")}</li>
          <li>{t("telemetry.destinations")}</li>
        </ul>
        <h3>{t("telemetry.privacyTitle")}</h3>
        <p className="muted">{t("telemetry.privacy")}</p>
        <p className="muted" style={{ marginBottom: 0 }}>
          {t("telemetry.storage")}
        </p>
      </section>
    </main>
  );
}
