/**
 * Probe Asterisk pjsip registrations against bridge lines.json.
 * Used by sip-reg-watchdog.sh (cron every 2 minutes on the VPS).
 *
 * stdout: JSON { ok, reason?, lines: [{ sipUsername, purpose, did, humanDid, agentName, status, bad }] }
 * Always exits 0 unless an unexpected internal error occurs.
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseRegistrationStatuses } from '../server/telephony/asteriskBridge';
import { formatOpsSms, formatUkDidForSms } from '../server/ops-sms';

const execFileAsync = promisify(execFile);

const LINES_PATH =
  process.env.SOHO66_BRIDGE_LINES_PATH
  || '/var/www/vhosts/b-diddies.com/tradepro-sip-bridge/lines.json';
const DOCKER_CONTAINER = process.env.SIP_BRIDGE_CONTAINER || 'tradepro-sip-bridge';

type BridgeLine = {
  sipUsername?: string;
  purpose?: string;
  did?: string;
  didE164?: string;
};

export function agentLabel(purpose: string | undefined): 'Judie' | 'Sally' {
  return purpose === 'sally' ? 'Sally' : 'Judie';
}

/** Human-readable UK DID for SMS (uses lines.json `did`, not sipUsername). */
export function formatHumanDid(did: string | undefined, didE164?: string): string {
  const raw = String(did || didE164 || '').trim();
  if (!raw) return '';
  return formatUkDidForSms(raw) || raw;
}

export function smsDownBody(agentName: string, humanDid: string): string {
  return formatOpsSms('phone_line_down', { persona: agentName, did: humanDid });
}

export function smsUpBody(agentName: string, humanDid: string): string {
  return formatOpsSms('phone_line_up', { persona: agentName, did: humanDid });
}

function emit(payload: object): never {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['ps', '--format', '{{.Names}}'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let raw: string;
  try {
    raw = await readFile(LINES_PATH, 'utf8');
  } catch {
    emit({ ok: false, reason: 'lines_missing', lines: [] });
  }

  let entries: BridgeLine[];
  try {
    const parsed = JSON.parse(raw) as BridgeLine[] | { lines?: BridgeLine[] };
    entries = Array.isArray(parsed) ? parsed : (parsed.lines ?? []);
  } catch {
    emit({ ok: false, reason: 'lines_invalid', lines: [] });
  }

  if (!entries.length) {
    emit({ ok: false, reason: 'lines_empty', lines: [] });
  }

  if (!(await dockerAvailable())) {
    emit({ ok: false, reason: 'docker_missing', lines: [] });
  }

  let regOutput = '';
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['exec', DOCKER_CONTAINER, 'asterisk', '-rx', 'pjsip show registrations'],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    regOutput = `${stdout ?? ''}${stderr ?? ''}`;
  } catch {
    emit({ ok: false, reason: 'asterisk_probe_failed', lines: [] });
  }

  const statuses = parseRegistrationStatuses(regOutput);
  const lines = entries
    .filter((e) => e.sipUsername)
    .map((e) => {
      const purpose = e.purpose || 'aria';
      const humanDid = formatHumanDid(e.did, e.didE164);
      const agentName = agentLabel(purpose);
      const status = statuses.get(String(e.sipUsername)) ?? 'Unknown';
      const bad = status !== 'Registered';
      return {
        sipUsername: String(e.sipUsername),
        purpose,
        did: e.did || e.didE164 || '',
        humanDid,
        agentName,
        status,
        bad,
        smsDown: smsDownBody(agentName, humanDid),
        smsUp: smsUpBody(agentName, humanDid),
      };
    });

  emit({ ok: true, lines });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
