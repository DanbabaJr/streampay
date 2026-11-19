"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/provider";

export default function SettingsNav() {
  const t = useT();

  return (
    <nav aria-label={t("settings.navigation")} className="filter-controls">
      <Link className="filter-btn" href="/settings/notifications">
        {t("settings.notifications")}
      </Link>
      <Link className="filter-btn" href="/settings/webhooks">
        {t("settings.webhooks")}
      </Link>
      <Link className="filter-btn" href="/settings/telemetry">
        {t("settings.telemetry")}
      </Link>
    </nav>
  );
}
