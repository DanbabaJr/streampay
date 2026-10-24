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

  "home.kicker": "SOROBAN · STELLAR",
  "home.title": "⚡ StreamPay",
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
};
