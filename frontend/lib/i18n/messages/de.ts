/**
 * German catalog. Typed against `MessageKey`, so this file cannot gain a key
 * English does not have, and cannot drop one, without `tsc` failing.
 *
 * Placeholder names must match English exactly (lib/i18n/catalog.spec.ts diffs
 * them per key and fails the test run on drift); the *order* and grammar may
 * differ freely, which is the whole point of ICU over string concatenation —
 * German puts the verb last, so `{amount}` and `{id}` move around.
 */

import type { MessageKey } from "./en";

export const de: Record<MessageKey, string> = {
  "brand.name": "StreamPay",
  "brand.tagline": "Zahlungs-Streams auf Stellar",
  "brand.footer": "StreamPay • Fortlaufende Zahlungströme für das Stellar-Netzwerk",

  "chrome.skipToContent": "Zum Hauptinhalt springen",
  "chrome.networkLive": "● Stellar {network}",
  "chrome.localeLabel": "Sprache",
  "chrome.networkText": "Stellar {network}",
  "chrome.contractLabel": "Vertrag {shortId}",
  "chrome.contractAria": "Streaming-Vertrags-ID {contractId} — öffnet den Block-Explorer",
  "chrome.contractUnset": "Vertrags-ID nicht konfiguriert",
  "chrome.walletOnNetwork": "Wallet ist im Netzwerk {network}",
  "chrome.appSignsFor": "Diese App unterschreibt für {network}.",
  "chrome.mismatchBody": "Transaktionen schlagen fehl, bis das Wallet übereinstimmt.",
  "chrome.dismissWarning": "Netzwerkwarnung ausblenden",
  "chrome.dashboard": "Übersicht",
  "chrome.backToDashboard": "Zurück zur Übersicht",
  "chrome.goToAppHome": "Zur Startseite",
  "chrome.apiDocs": "API-Doku ↗",
  "chrome.simulatorLink": "Accrual-Simulator →",

  "settings.navigation": "Einstellungen",
  "settings.title": "Einstellungen",
  "settings.description": "Verwalte Benachrichtigungen, Webhooks und Telemetrie im Browser.",
  "settings.notifications": "Benachrichtigungen",
  "settings.webhooks": "Webhook-Endpunkte",
  "settings.telemetry": "Telemetrie",
  "telemetry.title": "Telemetrie und Tracing",
  "telemetry.description": "Lege fest, ob dieser Browser Diagnose-Traces exportiert. Die Auswahl gilt sofort und wird auf diesem Gerät gespeichert.",
  "telemetry.scope": "Diese Einstellung steuert browserseitige Traces und Transaktionskorrelationsanfragen. Serverseitiges Tracing wird durch die Bereitstellung konfiguriert.",
  "telemetry.statusEnabled": "Telemetrie ist aktiviert.",
  "telemetry.statusDisabled": "Telemetrie ist deaktiviert.",
  "telemetry.toggleLabel": "Diagnose-Telemetrie erlauben",
  "telemetry.toggleHelp": "Wenn deaktiviert, exportiert dieser Browser keine Spans und Transaktionskorrelationsdaten mehr.",
  "telemetry.collectedTitle": "Enthaltene Telemetriedaten",
  "telemetry.spans": "Trace-Spans können Vorgangsnamen und -typen, Erfolgs- oder Fehlerstatus, Zeitstempel und Dauer, generierte Trace- und Span-IDs, Eltern- und Link-Beziehungen, Dienstname und -version der App, Ereignisnamen sowie bereinigte Attribute enthalten.",
  "telemetry.correlation": "Nach einer Transaktion können Korrelationsdaten deren Transaktions-Hash, Trace-Kontext und optionale Stream-ID enthalten. Sie werden an den konfigurierten Indexer gesendet, damit ein späteres Ledger-Ereignis mit dem Browser-Trace verknüpft werden kann.",
  "telemetry.destinations": "Abgeschlossene Spans werden an den über NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT konfigurierten OTLP-HTTP-Collector gesendet (Standard: http://localhost:4318/v1/traces). Korrelationsdaten gehen an den über NEXT_PUBLIC_INDEXER_URL konfigurierten Indexer (Standard: http://localhost:8787).",
  "telemetry.privacyTitle": "Filter und Grenzen",
  "telemetry.privacy": "Telemetrieattribute lassen Felder mit den Namen amount, balance, deposit oder withdrawn aus. Adressfelder werden auf ein 8-stelliges Präfix gekürzt; Webhook-URLs werden auf ihren Ursprung reduziert; bei E-Mail-Adressen bleibt nur die Domain sichtbar; Telegram-IDs zeigen nur die letzten vier Zeichen. Muster geheimer Schlüssel und Bearer-Tokens werden in Fehlermeldungen unkenntlich gemacht. Andere Diagnosenamen und Fehlerdetails können weiterhin enthalten sein. Gib dort keine vertraulichen Informationen ein.",
  "telemetry.storage": "Diese Auswahl wird in localStorage unter streampay:telemetryConsent gespeichert. Ohne gespeicherte Auswahl bleibt Telemetrie wie zuvor standardmäßig aktiviert.",

  "home.kicker": "SOROBAN · STELLAR",
  "home.title": "⚡ StreamPay",
  "home.settings": "Einstellungen",
  "home.browse": "Verzeichnis durchsuchen →",
  "home.unitsWord": "Einheiten",
  "home.tagline":
    "Fortlaufende Zahlungströme pro Sekunde — Gehalt, Vesting, Abos. Verbinde Freighter, um zu beginnen.",
  "home.connect": "Freighter verbinden",
  "home.connectedLabel": "Verbunden:",
  "home.connectedAs": "Verbunden: {address}",
  "home.fetchById": "Stream per ID abrufen",
  "home.streamIdPlaceholder": "Stream-ID",
  "home.fetch": "Stream abrufen",
  "home.fetching": "Wird abgerufen …",
  "home.yourStreams": "Deine Streams",
  "home.discoverOnchain": "On-chain suchen",
  "home.discovered":
    "Auf der Chain {count, plural, =0 {kein Stream} one {# Stream} other {# Streams}} gefunden.",
  "home.streamLoaded": "Stream #{id} geladen.",
  "home.streamNotFound": "Stream nicht gefunden. Prüfe die ID und versuche es erneut.",
  "home.enterStreamId": "Bitte gib eine Stream-ID ein.",
  "home.created": "Stream #{id} erstellt.",
  "home.batchCreated":
    "{count, plural, one {# Stream} other {# Streams}} erstellt: {ids}.",
  "home.withdrew": "{amount} aus Stream #{id} abgehoben.",
  "home.claimed": "{amount} aus Stream #{id} beansprucht.",
  "home.toppedUp": "Stream #{id} um {amount} aufgestockt.",
  "home.cancelled": "Stream #{id} storniert.",
  "home.walletMissing": "Freighter nicht erkannt — Erweiterung installieren und neu laden.",
  "home.walletNoAddress": "Freighter hat keine Adresse zurückgegeben.",
  "home.walletFailed": "Wallet-Verbindung fehlgeschlagen: {reason}",

  "empty.dashboard.title": "Noch keine Streams",
  "empty.dashboard.body":
    "Deine Zahlungs-Streams erscheinen hier. Erstelle oben deinen ersten Stream oder stöbere im Verzeichnis.",
  "empty.dashboard.action": "Verzeichnis durchsuchen",
  "empty.listings.title": "Keine Listings gefunden",
  "empty.listings.body":
    "Noch keine öffentlichen Streams passen zu den aktuellen Filtern. Listings bleiben verborgen, bis genügend Streams dieselben Bänder teilen — aktiviere oben „Streams mit geringer Anonymität anzeigen“ für seltene Fälle.",
  "empty.listings.action": "Stream erstellen",
  "empty.analytics.title": "Keine Streams zur Analyse",
  "empty.analytics.body":
    "Gib oben eine Stellar-Adresse ein oder erstelle deinen ersten Stream, um Akkumulationsverlauf und Ertragsprognosen zu sehen.",
  "empty.analytics.action": "Stream erstellen",

  "pay.loading.title": "Zahlungslink wird geprüft",
  "pay.loading.body":
    "Kryptografische Bindung auf Stellar Soroban wird verifiziert …",
  "pay.invalid.title": "Ungültiger Zahlungslink",
  "pay.invalid.body":
    "Dieser Zahlungslink ist fehlerhaft, beschädigt oder abgelaufen.",
  "pay.invoice.kicker": "Zahlungslink-Rechnung",
  "pay.invoice.title": "Stream #{id}",
  "pay.invoice.active": "Aktiver Stream",
  "pay.invoice.availableLabel": "Jetzt zum Abheben verfügbar",
  "pay.invoice.streaming": "Läuft linear in Echtzeit",
  "pay.invoice.progress": "Fortschritt: {percent}",
  "pay.invoice.total": "Gesamt: {amount} {unit, select, tokens {Tokens} other {Einheiten}}",
  "pay.invoice.unit.tokens": "Tokens",
  "pay.invoice.payer": "Zahler (Sender)",
  "pay.invoice.payee": "Empfänger (Payee)",
  "pay.invoice.payeeProtected": "🔒 Geschützte verschleierte Bindung",
  "pay.invoice.token": "Token-Vertrag",
  "pay.invoice.alreadyClaimed": "Bereits abgehoben",
  "pay.invoice.endTime": "Endzeitpunkt",
  "pay.wallet.connected": "Verbundenes Wallet",
  "pay.wallet.verified": "✓ Verifizierter Empfänger",
  "pay.wallet.mismatch": "✕ Empfänger stimmt nicht überein",
  "pay.error.heading": "Problem bei Prüfung oder Abhebung",
  "pay.error.noWallet":
    "Kein Freighter-Wallet erkannt. Bitte Freighter installieren, um abzuheben.",
  "pay.error.rejected": "Wallet-Freigabe abgelehnt.",
  "pay.error.bindingMismatch":
    "Das verbundene Wallet entspricht nicht der verschleierten Empfängerbindung dieses Streams.",
  "pay.action.connectAndClaim": "Freighter verbinden & abheben",
  "pay.action.claiming": "Abhebung wird an Stellar gesendet …",
  "pay.action.claim": "{amount} Tokens abheben",
  "pay.action.switchAccount": "Konto wechseln (Empfänger stimmt nicht überein)",
  "pay.action.nothingToClaim": "Kein gutgeschriebenes Guthaben zum Abheben",
  "pay.note":
    "Kein Passwort und keine Kontoregistrierung nötig. Gesichert durch Stellar-Soroban-Smart-Contracts.",
  "pay.terminal.cancelledTitle": "Stream storniert",
  "pay.terminal.depletedTitle": "Stream ausgeschöpft",
  "pay.terminal.completedTitle": "Stream abgeschlossen",
  "pay.terminal.cancelledBody":
    "Dieser Zahlungsstream wurde on-chain storniert. Verbliebene Treuhandmittel wurden aufgeteilt und erstattet.",
  "pay.terminal.depletedBody":
    "Alle in diesem Stream gesperrten Tokens wurden vom Empfänger bereits abgehoben.",
  "pay.terminal.completedBody":
    "Dieser Stream ist beendet; es bleibt kein unverforderter Restbetrag.",
  "pay.terminal.streamId": "Stream-ID",
  "pay.terminal.totalFunded": "Gesamt eingezahlt",
  "pay.terminal.totalWithdrawn": "Gesamt abgehoben",
  "pay.terminal.status": "Status",
  "pay.receipt.title": "Mittel erfolgreich abgehoben",
  "pay.receipt.body":
    "Dein gutgeschriebenes Stream-Guthaben wurde direkt in dein Wallet auf Stellar übertragen.",
  "pay.receipt.claimedAmount": "Abgehobener Betrag",
  "pay.receipt.recipientWallet": "Empfänger-Wallet",
  "pay.receipt.txHash": "Transaktions-Hash",
  "pay.receipt.explorer": "Auf Stellar Expert ansehen ↗",

  "meta.pay.notFound.title": "StreamPay — Zahlungslink nicht gefunden",
  "meta.pay.notFound.description":
    "Dieser StreamPay-Zahlungslink ist ungültig oder konnte on-chain nicht aufgelöst werden.",
  "meta.pay.notFound.ogTitle": "StreamPay — Ungültiger Zahlungslink",
  "meta.pay.notFound.ogDescription": "Ungültige oder abgelaufene Stream-Referenz.",
  "meta.pay.status.active": "Aktiver Stream",
  "meta.pay.status.cancelled": "Stornierter Stream",
  "meta.pay.status.depleted": "Vollständig abgehobener Stream",
  "meta.pay.status.completed": "Abgeschlossener Stream",
  "meta.pay.title": "{status}: {amount} {unit} — {brand}",
  "meta.pay.description":
    "Fortlaufender Zahlungsstrom auf Stellar (Soroban). Gesamteinzahlung: {amount} {unit}. Öffne diesen Link, um ein Wallet zu verbinden und das gutgeschriebene Guthaben abzuheben.",

  "form.depositLabel": "Einzahlung (kleinste Einheit)",
  "form.depositHint":
    "Gesamtbetrag, der im Stream gesperrt wird, in der kleinsten Token-Einheit (Stroops bei XLM, 7 Nachkommastellen).",
  "form.durationLabel": "Laufzeit (Tage)",
  "form.recipientLabel": "Empfänger",
  "form.required": "erforderlich",
  "form.heading": "Stream anlegen",
  "form.srDescription":
    "Fülle die folgenden Felder aus, um einen pro Sekunde laufenden Zahlungsstrom auf Stellar anzulegen. Pflichtfelder sind mit einem Sternchen (*) markiert.",
  "form.tokenLabel": "Token-Vertrags-ID",
  "form.tokenPlaceholder": "C… (Stellar-Asset-Contract-ID des Assets)",
  "form.tokenHint":
    "Gib die Stellar Asset Contract (SAC) ID des Tokens ein, den du streamen möchtest. Sie beginnt mit dem Buchstaben C.",
  "form.recipientHint": "Gib den öffentlichen Schlüssel (G…-Adresse) des Stream-Empfängers ein.",
  "form.nativeContractNote": "Natives XLM streamt über seinen Stellar Asset Contract: {contractId}",
  "form.asset": "Asset",
  "form.assetNative": "Natives XLM",
  "form.assetContract": "Token-Vertrag (USDC-artig)",
  "form.cancelableLabel": "Empfänger darf stornieren?",
  "form.yes": "Ja (stornierbar)",
  "form.no": "Nein (nur Zahler)",
  "form.submit": "Stream erstellen",
  "form.submitting": "Stream wird gestartet …",
  "form.preview.aria": "Stream-Vorschau",
  "form.preview.title": "Stream-Vorschau",
  "form.preview.totalDeposit": "Einzahlung gesamt",
  "form.preview.dailyRate": "Tägliche Flussrate",
  "form.preview.perSecondRate": "Rate pro Sekunde",
  "form.unitPerDay": "/Tag",
  "form.unitPerSecond": "/s",
  "form.amountsNote":
    "Beträge sind in der kleinsten Einheit ({decimals, number} Nachkommastellen bei {code}). Die Oberfläche prüft zuerst den Token-Freigabewert und bittet Freighter nur bei einer Lücke um die Freigabe der Einzahlung — rechne mit ein oder zwei Signaturen.",
  "form.policyHeading": "Aktive Richtliniengrenzen:",
  "form.policyMinDeposit": "Mindesteinzahlung",
  "form.policyMinDuration": "Mindestlaufzeit",
  "form.policyMaxDuration": "Maximale Laufzeit",
  "form.policyMinRate": "Mindestrate",
  "form.policyMaxRate": "Maximale Rate",
  "form.policyDepositLow": "Die Einzahlung liegt unter der Richtliniengrenze von {min} Einheiten.",
  "form.policyDurationLow": "Die Laufzeit ({actual, number}s) liegt unter der Richtliniengrenze von {min, number}s.",
  "form.policyDurationHigh": "Die Laufzeit ({actual, number}s) überschreitet die Richtliniengrenze von {max, number}s.",
  "form.policyRateLow": "Die Akkumulationsrate ({rate}/s) liegt unter der Richtliniengrenze von {min}/s.",
  "form.policyRateHigh": "Die Akkumulationsrate ({rate}/s) überschreitet die Richtliniengrenze von {max}/s.",
  "form.amountEmpty": "Bitte einen Betrag eingeben.",
  "form.amountNegative": "Der Betrag muss größer als null sein.",
  "form.amountAmbiguous":
    "Die Trennzeichen in „{input}“ sind mehrdeutig. Verwende {group} zwischen Dreier-Zifferngruppen und {decimal} höchstens einmal.",
  "form.amountGroupedOnly":
    "Verwende nur Ziffern, optional mit {separator} als Tausendertrennzeichen.",
  "form.amountTooPrecise":
    "Dieses Token hat höchstens {decimals, number} Nachkommastellen — der eingegebene Betrag müsste gerundet werden.",
  "form.amountInvalid": "Das ist kein lesbarer Betrag.",
  "form.recipientRequired": "Gib eine Empfängeradresse ein.",
  "form.recipientInvalid": "Gib eine gültige Stellar-Adresse ein (G… mit gültiger Prüfsumme).",
  "form.tokenRequired": "Gib eine Token-Vertrags-ID ein.",
  "form.tokenInvalid": "Gib eine gültige Token-Vertrags-ID ein (C… mit gültiger Prüfsumme).",
  "form.durationInvalid": "Gib eine Laufzeit in Tagen größer als null ein (bis zu 36.500 Tagen).",
  "form.durationTooLong": "Die Laufzeit überschreitet das Protokollmaximum von {max, number} Sekunden.",
  "form.depositTooSmallForDuration":
    "Die Einzahlung ist für diese Laufzeit zu klein — mindestens {min} sind nötig, damit der Stream anwächst.",
  "form.depositTooLarge":
    "Die Einzahlung ist für diese Laufzeit zu groß — reduziere die Einzahlung oder verkürze die Laufzeit.",
  "form.depositTransferFailed":
    "Die Einzahlung konnte nicht abgebucht werden — prüfe Guthaben und Token-Freigabe für Einzahlung plus Gebühr.",
  "form.recipientPayoutFailed":
    "Der Empfänger konnte nicht ausgezahlt werden — prüfe, ob die Adresse eine gültige Trustline hat und autorisiert ist.",
  "form.assetNotAllowed": "Dieses Token steht nicht auf der Zulassungsliste der Governance-Richtlinie.",
  "form.batchEmpty": "Füge mindestens eine CSV-Zeile hinzu.",
  "form.batchTooLarge": "Die Charge hat zu viele Zeilen (maximal {max, number}).",
  "form.batchRowIssue": "Zeile {row, number}: {detail}",

  "notFound.notFound": "Nicht gefunden",
  "notFound.badRequest": "Anfrageproblem",
  "notFound.stream.title": "Stream nicht gefunden",
  "notFound.stream.lookedFor": "Wir haben nach der Stream-ID in dieser URL gesucht.",
  "notFound.stream.why":
    "Auf diesem Netzwerk gibt es keinen Stream mit dieser ID. Er wurde möglicherweise nie erstellt, oder der Link ist unvollständig.",
  "notFound.stream.next":
    "Prüfe die Stream-ID oder kehre zur Übersicht zurück und öffne den Stream aus deiner Liste.",
  "notFound.stream.malformedTitle": "Ungültige Stream-ID",
  "notFound.stream.malformedBody":
    "„{id}“ ist keine gültige Stream-ID. Stream-IDs sind ganze Zahlen.",
  "notFound.address.title": "Adresse nicht gefunden",
  "notFound.address.lookedFor": "Wir haben nach der Stellar-Adresse in dieser URL gesucht.",
  "notFound.address.why":
    "Diese Adresse hat auf diesem Netzwerk noch keine Zahlungs-Streams erstellt oder empfangen.",
  "notFound.address.next":
    "Prüfe die Adresse auf Tippfehler oder beginne in der Übersicht mit deinen eigenen Streams.",
  "notFound.address.malformedTitle": "Ungültige Adresse",
  "notFound.address.malformedBody":
    "„{address}“ ist keine gültige Stellar-Adresse. Sie muss ein 56-stelliger öffentlicher Schlüssel sein, der mit G beginnt.",
  "notFound.pay.title": "Zahlungslink nicht gefunden",
  "notFound.pay.lookedFor": "Wir haben nach der Zahlungsreferenz in diesem Link gesucht.",
  "notFound.pay.why":
    "Dieser Link ist unbekannt. Möglicherweise wurde er falsch eingegeben oder abgeschnitten.",
  "notFound.pay.next":
    "Bitte den Zahler, den Link erneut zu senden, oder öffne die Übersicht.",
  "notFound.pay.malformedTitle": "Ungültiger Zahlungslink",
  "notFound.pay.malformedBody": "Dieser Zahlungslink ist fehlerhaft oder beschädigt.",

  "share.heading": "Diesen Zahlungslink teilen",
  "share.body":
    "Scanne den QR-Code oder kopiere den Link. Die Referenz wird in deinem Browser erzeugt und nie an Dritte gesendet.",
  "share.qrLabel": "QR-Code für diesen Zahlungslink",
  "share.copy": "Link kopieren",
  "share.copyLabel": "Zahlungslink in die Zwischenablage kopieren",
  "share.copied": "Zahlungslink in die Zwischenablage kopiert.",
  "share.copiedButton": "Kopiert!",
  "share.copyFailed":
    "Der Link konnte nicht kopiert werden. Markiere ihn und kopiere ihn manuell.",
};
