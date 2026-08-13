/**
 * CLI: send a plain-English ops alert SMS via Twilio.
 * Used by api-health-watchdog.sh when the API process may be down.
 *
 * Usage:
 *   tsx --env-file=.env scripts/ops-send-alert-sms.ts --to +447576442345 --kind api_down
 */
import { formatOpsSms, type OpsSmsKind } from '../server/ops-sms';
import { sendTwilioSms } from '../server/telephony/twilioAdapter';

const VALID_KINDS: OpsSmsKind[] = [
  'api_down',
  'api_recovered',
  'api_restarted',
  'phone_line_down',
  'phone_line_up',
  'call_failed',
  'orders_backup',
  'ops_alert',
  'test',
];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

async function main() {
  const to = (arg('--to') || process.env.TO || '').trim();
  const kindRaw = (arg('--kind') || process.env.KIND || '').trim() as OpsSmsKind;
  if (!to || !kindRaw) {
    console.error(
      'usage: ops-send-alert-sms.ts --to +447576442345 --kind api_down|api_recovered|phone_line_down|test',
    );
    process.exit(2);
  }
  if (!VALID_KINDS.includes(kindRaw)) {
    console.error(`invalid --kind: ${kindRaw}`);
    process.exit(2);
  }
  const body = formatOpsSms(kindRaw, {
    persona: arg('--persona'),
    did: arg('--did'),
    title: arg('--title'),
    message: arg('--message'),
  });
  const result = await sendTwilioSms(to, body);
  if (result.stub) {
    console.error(JSON.stringify({ ok: false, error: 'twilio_not_configured', stub: true }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, sid: result.sid }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
