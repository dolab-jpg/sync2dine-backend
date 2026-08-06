/**
 * CLI: send a plain-text ops alert email via connected Gmail OAuth (or SMTP fallback).
 * Used by api-health-watchdog.sh when the API process may be down.
 *
 * Usage:
 *   tsx --env-file=.env scripts/ops-send-alert-email.ts --to EMAIL --subject "…" --body "…"
 */
import { sendOpsAlertEmail } from '../server/ops-gmail-send';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

async function main() {
  const to = (arg('--to') || process.env.TO || '').trim();
  const subject = (arg('--subject') || process.env.SUBJECT || 'Sync2Dine ops alert').trim();
  const body = (arg('--body') || process.env.BODY || '').trim();
  if (!to) {
    console.error('usage: ops-send-alert-email.ts --to EMAIL --subject "…" --body "…"');
    process.exit(2);
  }
  const result = await sendOpsAlertEmail({ to, subject, text: body || subject });
  if (!result.ok) {
    console.error(JSON.stringify(result));
    process.exit(1);
  }
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
