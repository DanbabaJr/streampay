#!/usr/bin/env node
/**
 * On-call handoff notifier for StreamPay.
 *
 * Deterministically computes the current primary and secondary on-call engineer
 * from scripts/oncall/rotation.json based on elapsed rotation periods since startDate.
 *
 * Safety & Operations:
 * - Safe by default: If ONCALL_WEBHOOK_URL is unset, logs a notice and exits 0.
 * - Dry-run support: Supports DRY_RUN=1 or --dry-run to print the message without sending.
 * - Secret hygiene: Never prints or logs the webhook URL or authorization tokens.
 * - Zero dependencies: Pure Node.js built-ins only (fs, path, fetch).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROSTER_PATH = join(__dirname, 'rotation.json');

function loadRoster() {
  try {
    const raw = readFileSync(ROSTER_PATH, 'utf8');
    const roster = JSON.parse(raw);
    if (!roster.startDate || !Array.isArray(roster.members) || roster.members.length === 0) {
      throw new Error('Roster must contain a valid startDate and at least one member');
    }
    if (typeof roster.rotationLengthDays !== 'number' || roster.rotationLengthDays <= 0) {
      throw new Error('rotationLengthDays must be a positive integer');
    }
    return roster;
  } catch (err) {
    console.error(`[oncall-ping] ERROR: Failed to load rotation roster: ${err.message}`);
    process.exit(1);
  }
}

export function computeOnCall(roster, targetDate = new Date()) {
  const start = new Date(roster.startDate);
  const now = new Date(targetDate);
  const diffMs = now.getTime() - start.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const rotationLength = roster.rotationLengthDays;
  const cycleIndex = Math.floor(diffDays / rotationLength);

  const numMembers = roster.members.length;
  // Modulo math with support for negative offsets if date precedes start
  const primaryIndex = ((cycleIndex % numMembers) + numMembers) % numMembers;
  const secondaryIndex = (primaryIndex + 1) % numMembers;

  const currentShiftStart = new Date(start.getTime() + cycleIndex * rotationLength * 86400000);
  const currentShiftEnd = new Date(currentShiftStart.getTime() + rotationLength * 86400000);

  return {
    primary: roster.members[primaryIndex],
    secondary: roster.members[secondaryIndex],
    shiftStart: currentShiftStart.toISOString().slice(0, 10),
    shiftEnd: currentShiftEnd.toISOString().slice(0, 10),
    cycleIndex,
  };
}

export function formatPayload(onCallInfo) {
  const text = [
    `📟 *StreamPay On-Call Handoff Announcement*`,
    `• *Primary*: @${onCallInfo.primary.handle} (${onCallInfo.primary.name})`,
    `• *Secondary*: @${onCallInfo.secondary.handle} (${onCallInfo.secondary.name})`,
    `• *Shift Window*: ${onCallInfo.shiftStart} to ${onCallInfo.shiftEnd} (UTC)`,
    `• *Escalation Path*: Primary (@${onCallInfo.primary.handle}) ➔ Secondary (@${onCallInfo.secondary.handle}) ➔ Project Lead (@Neziahtech)`,
    `• *Handbook & Runbook*: See docs/OPERATIONS.md & docs/INCIDENT_RUNBOOK.md`,
  ].join('\n');

  return {
    text,
    // Slack/Discord compatible JSON envelope
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text,
        },
      },
    ],
  };
}

async function main() {
  const isDryRun = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
  const webhookUrl = process.env.ONCALL_WEBHOOK_URL;

  const roster = loadRoster();
  const onCallInfo = computeOnCall(roster);
  const payload = formatPayload(onCallInfo);

  if (isDryRun) {
    console.log('[oncall-ping] DRY RUN MODE: Notification calculated successfully.');
    console.log(JSON.stringify({ onCallInfo, payload }, null, 2));
    process.exit(0);
  }

  if (!webhookUrl) {
    console.log('[oncall-ping] NOTICE: ONCALL_WEBHOOK_URL is not set. Safe no-op; exiting 0.');
    process.exit(0);
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`[oncall-ping] ERROR: Webhook POST failed with HTTP status ${res.status}`);
      process.exit(1);
    }

    console.log('[oncall-ping] Successfully delivered on-call handoff notification.');
    process.exit(0);
  } catch (err) {
    console.error(`[oncall-ping] ERROR: Network exception while contacting webhook: ${err.message}`);
    process.exit(1);
  }
}

// Execute if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
