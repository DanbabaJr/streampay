/**
 * English catalog — the source of truth for the message keys.
 *
 * Every other catalog is typed `Record<MessageKey, string>`, so a missing or
 * misspelled key here is a `tsc` error in every locale, and `de.ts` cannot gain
 * or lose a key without the build failing. That is why the catalog is a TS
 * module rather than JSON: the type is derived from the data with no codegen
 * step. Contributors edit this file plus their own locale's file; nothing else.
 *
 * Message syntax is ICU MessageFormat (see docs/I18N.md for why):
 *   {name}                     plain interpolation
 *   {count, plural, one {...} other {...}}   grammatical number
 *   {status, select, active {...} other {...}}  choice by value
 *
 * HOUSE RULE, enforced by lib/i18n/amounts.test.ts: a token amount is passed
 * already formatted by `formatStroops`, as a **string**. Handing ICU a Number is
 * how the 7th decimal dies. Counts, percentages and durations are plain numbers
 * and may use ICU's own `number` / `percent` formatting.
 */

export const en = {
  "brand.name": "StreamPay",
  "brand.tagline": "Streaming payments on Stellar",
  "brand.footer": "StreamPay • Continuous streaming payments for the Stellar network",

  "chrome.skipToContent": "Skip to main content",
  "chrome.networkLive": "● Stellar {network}",
  "chrome.localeLabel": "Language",
  "chrome.networkText": "Stellar {network}",
  "chrome.contractLabel": "contract {shortId}",
  "chrome.contractAria": "Streaming contract id {contractId} — opens the block explorer",
  "chrome.contractUnset": "contract id not configured",
  "chrome.walletOnNetwork": "Wallet is on {network}",
  "chrome.appSignsFor": "This app signs for {network}.",
  "chrome.mismatchBody": "Transactions will fail until the wallet matches.",
  "chrome.dismissWarning": "Dismiss network warning",
  "chrome.dashboard": "Dashboard",
  "chrome.backToDashboard": "Back to Dashboard",
  "chrome.goToAppHome": "Go to App Home",
  "chrome.apiDocs": "API Docs ↗",
  "chrome.simulatorLink": "Accrual Simulator →",

  "home.kicker": "SOROBAN · STELLAR",
  "home.title": "⚡ StreamPay",
  "home.browse": "Browse Discovery Directory →",
  "home.unitsWord": "units",
  "home.tagline":
    "Continuous, per-second payment streams — payroll, vesting, subscriptions. Connect Freighter to begin.",
  "home.connect": "Connect Freighter",
  "home.connectedLabel": "Connected:",
  "home.connectedAs": "Connected: {address}",
  "home.fetchById": "Fetch stream by ID",
  "home.streamIdPlaceholder": "Stream ID",
  "home.fetch": "Fetch stream",
  "home.fetching": "Fetching…",
  "home.yourStreams": "Your streams",
  "home.discoverOnchain": "Discover on-chain",
  "home.discovered":
    "Discovered {count, plural, =0 {no streams} one {# stream} other {# streams}} on-chain.",
  "home.streamLoaded": "Stream #{id} loaded.",
  "home.streamNotFound": "Stream not found. Check the ID and try again.",
  "home.enterStreamId": "Enter a stream ID.",
  "home.created": "Stream #{id} created.",
  "home.batchCreated":
    "{count, plural, one {# stream} other {# streams}} created: {ids}.",
  "home.withdrew": "Withdrew {amount} from stream #{id}.",
  "home.claimed": "Claimed {amount} from stream #{id}.",
  "home.toppedUp": "Topped up stream #{id} by {amount}.",
  "home.cancelled": "Stream #{id} cancelled.",
  "home.walletMissing": "Freighter not detected — install the extension and reload.",
  "home.walletNoAddress": "no address returned from Freighter.",
  "home.walletFailed": "Wallet connection failed: {reason}",

  "pay.loading.title": "Resolving Payment Link",
  "pay.loading.body": "Verifying cryptographic commitment on Stellar Soroban…",
  "pay.invalid.title": "Invalid Payment Link",
  "pay.invalid.body":
    "This payment link reference is malformed, corrupted, or has expired.",
  "pay.invoice.kicker": "Payment Link Invoice",
  "pay.invoice.title": "Stream #{id}",
  "pay.invoice.active": "Active Stream",
  "pay.invoice.availableLabel": "Available to Claim Right Now",
  "pay.invoice.streaming": "Streaming linearly in real time",
  "pay.invoice.progress": "Progress: {percent}",
  "pay.invoice.total": "Total: {amount} {unit, select, tokens {Tokens} other {unit}}",
  "pay.invoice.unit.tokens": "Tokens",
  "pay.invoice.payer": "Payer (Sender)",
  "pay.invoice.payee": "Payee (Recipient)",
  "pay.invoice.payeeProtected": "🔒 Protected Blinded Binding",
  "pay.invoice.token": "Token Contract",
  "pay.invoice.alreadyClaimed": "Already Claimed",
  "pay.invoice.endTime": "End Time",
  "pay.wallet.connected": "Connected Wallet",
  "pay.wallet.verified": "✓ Verified Claimant",
  "pay.wallet.mismatch": "✕ Recipient Mismatch",
  "pay.error.heading": "Verification or Claim Issue",
  "pay.error.noWallet":
    "Freighter wallet not detected. Please install Freighter to claim.",
  "pay.error.rejected": "Wallet authorization rejected.",
  "pay.error.bindingMismatch":
    "Connected wallet does not match the blinded recipient binding for this stream.",
  "pay.action.connectAndClaim": "Connect Freighter & Claim",
  "pay.action.claiming": "Submitting Claim to Stellar…",
  "pay.action.claim": "Claim {amount} Tokens",
  "pay.action.switchAccount": "Switch Account (Recipient Mismatch)",
  "pay.action.nothingToClaim": "Zero Accrued Funds to Claim",
  "pay.note":
    "No password or account creation required. Secured by Stellar Soroban smart contracts.",
  "pay.terminal.cancelledTitle": "Stream Cancelled",
  "pay.terminal.depletedTitle": "Stream Depleted",
  "pay.terminal.completedTitle": "Stream Completed",
  "pay.terminal.cancelledBody":
    "This payment stream was cancelled on-chain. Remaining escrow was split and refunded.",
  "pay.terminal.depletedBody":
    "All tokens locked in this stream have already been claimed by the recipient.",
  "pay.terminal.completedBody":
    "This stream has concluded and there is zero uncollected balance remaining.",
  "pay.terminal.streamId": "Stream ID",
  "pay.terminal.totalFunded": "Total Funded",
  "pay.terminal.totalWithdrawn": "Total Withdrawn",
  "pay.terminal.status": "Status",
  "pay.receipt.title": "Funds Claimed Successfully",
  "pay.receipt.body":
    "Your accrued stream funds have been transferred directly to your wallet on Stellar.",
  "pay.receipt.claimedAmount": "Claimed Amount",
  "pay.receipt.recipientWallet": "Recipient Wallet",
  "pay.receipt.txHash": "Transaction Hash",
  "pay.receipt.explorer": "View on Stellar Expert ↗",

  "meta.pay.notFound.title": "StreamPay — Payment Link Not Found",
  "meta.pay.notFound.description":
    "This StreamPay payment link reference is invalid or could not be resolved on-chain.",
  "meta.pay.notFound.ogTitle": "StreamPay — Invalid Payment Link",
  "meta.pay.notFound.ogDescription": "Invalid or expired stream reference.",
  "meta.pay.status.active": "Active Stream",
  "meta.pay.status.cancelled": "Cancelled Stream",
  "meta.pay.status.depleted": "Fully Claimed Stream",
  "meta.pay.status.completed": "Completed Stream",
  "meta.pay.title": "{status} — {amount} {unit} | {brand}",
  "meta.pay.description":
    "Continuous streaming payment on Stellar (Soroban). Total deposit: {amount} {unit}. Open this link to connect a wallet and claim accrued funds.",

  "form.depositLabel": "Deposit (smallest units)",
  "form.depositHint":
    "Total amount to lock in the stream, in the token's smallest unit (stroops for XLM, 7 decimal places).",
  "form.durationLabel": "Duration (days)",
  "form.recipientLabel": "Recipient",
  "form.required": "required",
  "form.heading": "Create a stream",
  "form.srDescription":
    "Fill in the fields below to create a per-second payment stream on Stellar. Required fields are marked with an asterisk (*).",
  "form.tokenLabel": "Token contract id",
  "form.tokenPlaceholder": "C… (Stellar Asset Contract id of the asset)",
  "form.tokenHint":
    "Enter the Stellar Asset Contract (SAC) id for the token you want to stream. It starts with the letter C.",
  "form.recipientHint": "Enter the Stellar public key (G… address) of the stream recipient.",
  "form.nativeContractNote": "Native XLM streams through its Stellar Asset Contract: {contractId}",
  "form.asset": "Asset",
  "form.assetNative": "Native XLM",
  "form.assetContract": "Token contract (USDC-style)",
  "form.cancelableLabel": "Recipient may cancel?",
  "form.yes": "Yes (cancelable)",
  "form.no": "No (sender-only)",
  "form.submit": "Create stream",
  "form.submitting": "Streaming…",
  "form.preview.aria": "Stream preview",
  "form.preview.title": "Stream Preview",
  "form.preview.totalDeposit": "Total Deposit",
  "form.preview.dailyRate": "Daily Flow Rate",
  "form.preview.perSecondRate": "Per-Second Rate",
  "form.unitPerDay": "/day",
  "form.unitPerSecond": "/s",
  "form.amountsNote":
    "Amounts are in smallest units ({decimals, number} decimals for {code}). The UI checks the token allowance first and asks Freighter to approve the deposit only when it is short — expect one or two signatures.",
  "form.policyHeading": "Active Policy Floors:",
  "form.policyMinDeposit": "Min Deposit",
  "form.policyMinDuration": "Min Duration",
  "form.policyMaxDuration": "Max Duration",
  "form.policyMinRate": "Min Rate",
  "form.policyMaxRate": "Max Rate",
  "form.policyDepositLow": "Deposit is below the governance policy floor of {min} units.",
  "form.policyDurationLow": "Duration ({actual, number}s) is below the governance floor of {min, number}s.",
  "form.policyDurationHigh": "Duration ({actual, number}s) exceeds the governance ceiling of {max, number}s.",
  "form.policyRateLow": "Accrual rate ({rate}/s) is below the governance policy floor of {min}/s.",
  "form.policyRateHigh": "Accrual rate ({rate}/s) exceeds the governance policy ceiling of {max}/s.",
  "form.amountEmpty": "Enter an amount.",
  "form.amountNegative": "The amount must be greater than zero.",
  "form.amountAmbiguous":
    "The separators in “{input}” are ambiguous. Use {group} between groups of three digits and {decimal} at most once.",
  "form.amountGroupedOnly":
    "Use digits only, optionally with {separator} as a thousands separator.",
  "form.amountTooPrecise":
    "This token has at most {decimals, number} decimal places — the amount you typed would have to be rounded.",
  "form.amountInvalid": "That is not a readable amount.",
} as const;

export type MessageKey = keyof typeof en;
