import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function renderAlert(result) {
  if (result.status !== "failed" || !result.failure) {
    throw new Error("Cannot render a failure alert for a successful canary result");
  }
  const lines = [
    "StreamPay canary FAILED",
    `Network: ${result.network ?? "unverified"}`,
    `Step: ${result.failure.step}`,
    `Failure class: ${result.failure.failureClass}`,
    `RPC response: ${result.failure.rpcExcerpt}`,
    `Transaction XDR (unsigned): ${result.failure.transactionXdr ?? "not available"}`,
    `Operation XDR: ${result.failure.operationXdr ?? "not available"}`,
    `Contract: ${result.contractId ?? "not configured"}`,
    `Commit: ${result.attribution.commit ?? "unknown"}`,
    `Actor: ${result.attribution.actor ?? "unknown"}`,
    `Run: ${result.attribution.runUrl ?? "not available"}`,
  ];
  if (result.cleanupFailure) {
    lines.push(
      `Cleanup failure: ${result.cleanupFailure.step} (${result.cleanupFailure.failureClass})`,
      `Cleanup RPC response: ${result.cleanupFailure.rpcExcerpt}`,
      `Cleanup transaction XDR (unsigned): ${result.cleanupFailure.transactionXdr ?? "not available"}`,
      `Cleanup operation XDR: ${result.cleanupFailure.operationXdr ?? "not available"}`
    );
  }
  return lines.join("\n");
}

async function main() {
  const path = process.argv[2] ?? "canary-result.json";
  const result = JSON.parse(readFileSync(path, "utf8"));
  const alert = renderAlert(result);
  console.error(alert);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      "## Canary failure",
      "",
      ...alert.split("\n").map((line) => `- ${line}`),
      "",
    ].join("\n");
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  const webhookUrl = process.env.ONCALL_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("ONCALL_WEBHOOK_URL is not configured; alert is available in the workflow summary and evidence artifact.");
    return;
  }

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: alert }),
    });
  } catch {
    console.error("Canary alert webhook request failed due to a network error; the webhook URL was not logged.");
    process.exitCode = 1;
    return;
  }
  if (!response.ok) {
    console.error(`Canary alert webhook returned HTTP ${response.status}; the webhook URL was not logged.`);
    process.exitCode = 1;
    return;
  }
  console.log("Canary failure alert delivered.");
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
