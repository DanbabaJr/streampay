"use client";

import Link from "next/link";
import SettingsNav from "@/components/SettingsNav";
import { useT } from "@/lib/i18n/provider";

export default function SettingsPage() {
  const t = useT();

  return (
    <main className="wrap">
      <div style={{ marginBottom: 16 }}>
        <Link href="/" style={{ fontSize: 13, color: "var(--muted)" }}>
          ← {t("chrome.backToDashboard")}
        </Link>
      </div>
      <SettingsNav />
      <header style={{ margin: "20px 0" }}>
        <h1>{t("settings.title")}</h1>
        <p className="muted">{t("settings.description")}</p>
      </header>
    </main>
  );
}
