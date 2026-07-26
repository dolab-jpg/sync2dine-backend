/**
 * Multi-REGISTER Asterisk bridge sync.
 *
 * The VPS runs ONE Asterisk container (`tradepro-sip-bridge`) that must hold N
 * concurrent Soho66 REGISTERs ù one per customer Judie line plus Sally. This module
 * builds the COMPLETE line set from the data store, writes it to the bridge's
 * `lines.json`, and recreates the container so it re-registers every line.
 *
 * Semantics are full-replace: every sync rewrites the entire list from the DB.
 * Editing/going live for one customer never drops another customer or Sally.
 */
import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { collectAiPhoneLines, type AiBridgeLine } from '../phone-lines';
import { updatePhoneLineStatus, withOrgContext } from '../data-store';

export function getBridgeDir(): string {
  return (
    process.env.SOHO66_BRIDGE_DIR
    || '/var/www/vhosts/b-diddies.com/tradepro-sip-bridge'
  ).replace(/\/$/, '');
}

export function getBridgeLinesPath(): string {
  return process.env.SOHO66_BRIDGE_LINES_PATH || path.join(getBridgeDir(), 'lines.json');
}

/** Command that regenerates + reloads the bridge from lines.json. */
export function getBridgeApplyCmd(): string {
  const dir = getBridgeDir();
  return (
    process.env.SOHO66_BRIDGE_APPLY_CMD
    || `cd ${dir} && docker compose up -d --force-recreate`
  );
}

export type BridgeSyncLine = Omit<AiBridgeLine, 'sipPassword'> & { sipPassword: 'ùùùùùù' | '' };

export interface BridgeSyncResult {
  ok: boolean;
  count: number;
  linesPath: string;
  wrote: boolean;
  lines: BridgeSyncLine[];
  apply: { ran: boolean; ok: boolean; command: string; output: string };
  registrations?: string;
  message: string;
}

function maskLine(l: AiBridgeLine): BridgeSyncLine {
  return { ...l, sipPassword: l.sipPassword ? 'ùùùùùù' : '' };
}

function run(cmd: string, timeoutMs = 120_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve({ ok: !err, output });
    });
  });
}

export type AsteriskRegistrationStatus = 'Registered' | 'Unregistered' | 'Rejected' | 'Unknown';

/** Parse `pjsip show registrations` without treating "Unregistered" as "Registered". */
export function parseRegistrationStatuses(output: string): Map<string, AsteriskRegistrationStatus> {
  const statuses = new Map<string, AsteriskRegistrationStatus>();
  for (const row of String(output || '').split(/\r?\n/)) {
    const match = row.match(
      /^\s*reg-([^\s/]+)\/\S+\s+\S+\s+(Registered|Unregistered|Rejected)(?:\s|$)/i,
    );
    if (!match) continue;
    const value = match[2].toLowerCase();
    statuses.set(
      match[1],
      value === 'registered' ? 'Registered' : value === 'rejected' ? 'Rejected' : 'Unregistered',
    );
  }
  return statuses;
}

function updateAiLineStatus(
  line: AiBridgeLine,
  patch: Parameters<typeof updatePhoneLineStatus>[1],
): void {
  withOrgContext(line.orgId, () => {
    updatePhoneLineStatus(line.id, patch);
  });
}

/**
 * Rebuild the Asterisk bridge from ALL enabled aria+sally lines.
 * @param opts.apply run the docker recreate (default true). When false, only writes lines.json.
 */
export async function syncAsteriskBridge(opts?: { apply?: boolean }): Promise<BridgeSyncResult> {
  const apply = opts?.apply !== false;
  const lines = collectAiPhoneLines();
  const linesPath = getBridgeLinesPath();
  const masked = lines.map(maskLine);

  const payload = lines.map((l) => ({
    id: l.id,
    orgId: l.orgId,
    orgName: l.orgName,
    purpose: l.purpose,
    label: l.label,
    sipUsername: l.sipUsername,
    sipPassword: l.sipPassword,
    sipDomain: l.sipDomain,
    did: l.did,
    didE164: l.didE164,
    vapiUser: l.vapiUser,
    aiSipHost: l.aiSipHost,
  }));

  let wrote = false;
  try {
    await fs.mkdir(path.dirname(linesPath), { recursive: true });
    await fs.writeFile(linesPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    wrote = true;
  } catch (err) {
    return {
      ok: false,
      count: lines.length,
      linesPath,
      wrote: false,
      lines: masked,
      apply: { ran: false, ok: false, command: getBridgeApplyCmd(), output: '' },
      message: `Failed to write ${linesPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const applyCmd = getBridgeApplyCmd();
  let applyRes = { ok: false, output: '' };
  if (apply) {
    applyRes = await run(applyCmd);
    // Mark line statuses optimistically from apply success; live status confirmed by registration dump below.
    for (const l of lines) {
      updateAiLineStatus(l, {
        status: applyRes.ok ? 'registering' : 'error',
        lastError: applyRes.ok ? undefined : 'Bridge apply failed',
      });
    }
  }

  let registrations: string | undefined;
  if (apply && applyRes.ok) {
    // Give Asterisk time to (re)register every line before dumping ó the second/Nth
    // REGISTER can complete a few seconds after container start.
    await new Promise((r) => setTimeout(r, 12000));
    const dump = await run(
      `docker exec tradepro-sip-bridge asterisk -rx 'pjsip show registrations' 2>/dev/null || true`,
      30_000,
    );
    registrations = dump.output;
    const statuses = parseRegistrationStatuses(registrations);
    for (const l of lines) {
      const status = statuses.get(l.sipUsername) ?? 'Unknown';
      if (status === 'Registered') {
        updateAiLineStatus(l, {
          status: 'registered',
          registeredAt: new Date().toISOString(),
          lastError: undefined,
        });
      } else {
        updateAiLineStatus(l, {
          status: 'error',
          lastError: `Asterisk REGISTER status: ${status}`,
        });
      }
    }
  }

  const statuses = registrations ? parseRegistrationStatuses(registrations) : new Map();
  const allRegistered = !apply || lines.every((l) => statuses.get(l.sipUsername) === 'Registered');
  const ok = wrote && (!apply || (applyRes.ok && allRegistered));
  return {
    ok,
    count: lines.length,
    linesPath,
    wrote,
    lines: masked,
    apply: { ran: apply, ok: applyRes.ok, command: applyCmd, output: applyRes.output },
    registrations,
    message: ok
      ? `Synced ${lines.length} AI line(s) to Asterisk bridge${apply ? ' and recreated container' : ' (write-only)'}.`
      : applyRes.ok
        ? `Bridge reloaded, but not every AI line reached Registered status.`
        : `Wrote lines.json but bridge apply failed. Run "${applyCmd}" on the VPS.`,
  };
}
