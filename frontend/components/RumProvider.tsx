"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getConsent, onConsentChange, setConsent } from "@/lib/rum/consent";

// Mounts RUM collection and renders the consent prompt. Nothing is loaded or
// sent until the user opts in.
export default function RumProvider() {
  // Server snapshot is "granted" so the prompt never flashes during hydration.
  const state = useSyncExternalStore(
    (cb) => onConsentChange(cb),
    () => getConsent(),
    () => "granted" as const,
  );

  useEffect(() => {
    if (state !== "granted") return;
    let cancelled = false;
    import("@/lib/rum/client").then((m) => {
      if (!cancelled) m.startRum();
    });
    return () => {
      cancelled = true;
    };
  }, [state]);

  if (state !== "unset") return null;
  return (
    <div role="dialog" aria-label="Telemetry consent" className="rum-consent">
      <p>
        Share anonymous page performance (load speed, responsiveness, layout shift)? No wallet
        addresses, amounts or personal data are collected. Off unless you accept.
      </p>
      <button type="button" onClick={() => setConsent("granted")}>Allow</button>{" "}
      <button type="button" onClick={() => setConsent("denied")}>No thanks</button>
    </div>
  );
}
