/**
 * Resolve Call Centre transfer destinations (settings first, then env).
 */
import { getAgentSettings } from './data-store';
import { toE164Uk } from './vapi-client';

const DEPTS = ['general', 'sales', 'projects', 'recruitment', 'accounts'] as const;
export type TransferDept = (typeof DEPTS)[number];

function transferNumberFor(dept: TransferDept): string | undefined {
  const settings = getAgentSettings().transferNumbers ?? {};
  const envByDept: Record<TransferDept, string | undefined> = {
    general: process.env.VOICE_TRANSFER_NUMBER,
    sales: process.env.VOICE_TRANSFER_SALES,
    projects: process.env.VOICE_TRANSFER_PROJECTS,
    recruitment: process.env.VOICE_TRANSFER_RECRUITMENT,
    accounts: process.env.VOICE_TRANSFER_ACCOUNTS,
  };
  return settings[dept]?.trim() || envByDept[dept]?.trim() || undefined;
}

export function transferDestinationsFromEnv(): Array<Record<string, unknown>> {
  const destinations: Array<Record<string, unknown>> = [];
  const def = transferNumberFor('general');
  if (def) {
    destinations.push({
      type: 'number',
      number: toE164Uk(def),
      message: 'Putting you through to the team now.',
      description: 'Default office transfer',
    });
  }
  for (const dept of ['sales', 'projects', 'recruitment', 'accounts'] as const) {
    const n = transferNumberFor(dept);
    if (n) {
      destinations.push({
        type: 'number',
        number: toE164Uk(n),
        message: `Connecting you to ${dept}.`,
        description: dept,
      });
    }
  }
  return destinations;
}

export function resolveTransferNumber(department?: string): string | null {
  const dept = String(department || 'general').toLowerCase();
  const key = (DEPTS as readonly string[]).includes(dept) ? (dept as TransferDept) : 'general';
  const pick = transferNumberFor(key) || transferNumberFor('general');
  return pick ? toE164Uk(pick) : null;
}
