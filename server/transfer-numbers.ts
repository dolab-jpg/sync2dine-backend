/**
 * Resolve Call Centre transfer destinations (settings first, then env).
 * Destinations use Vapi warm-transfer-experimental: hold caller, dial staff, brief, then bridge.
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

/** Shared warm consult plan: hold caller → dial staff → brief → complete/cancel. */
export function buildWarmTransferPlan(opts?: {
  department?: string;
  reason?: string;
}): Record<string, unknown> {
  const dept = (opts?.department || 'the team').trim() || 'the team';
  const reasonBit = opts?.reason?.trim()
    ? ` Reason for transfer: ${opts.reason.trim().slice(0, 280)}.`
    : '';

  return {
    mode: 'warm-transfer-experimental',
    message: `Hi, Cynthia from Builder Diddies — I have a caller on hold for ${dept}.${reasonBit} Are you free to take them?`,
    holdAudioUrl: process.env.VOICE_TRANSFER_HOLD_AUDIO_URL?.trim()
      || 'https://music.vapi.ai/waiting-ringtone.mp3',
    voicemailDetectionType: 'transcript',
    fallbackPlan: {
      message: 'Sorry love, no one is free right now — I can take a message or try again shortly.',
      endCallEnabled: false,
    },
    summaryPlan: {
      enabled: true,
      messages: [
        {
          role: 'system',
          content: 'Summarise this call in one short spoken sentence for the staff member who will take over.',
        },
        {
          role: 'user',
          content: 'Here is the transcript:\n\n{{transcript}}\n\n',
        },
      ],
    },
    transferAssistant: {
      firstMessage: `Hi, Cynthia from Builder Diddies — caller on hold for ${dept}.${reasonBit} Can you take them?`,
      firstMessageMode: 'assistant-speaks-first',
      maxDurationSeconds: 90,
      model: {
        provider: 'openai',
        model: process.env.VAPI_TRANSFER_LLM_MODEL?.trim()
          || (process.env.VAPI_LLM_MODEL?.trim() && !/^gpt-4o/.test(process.env.VAPI_LLM_MODEL.trim())
            ? process.env.VAPI_LLM_MODEL.trim()
            : 'gpt-4.1'),
        messages: [
          {
            role: 'system',
            content: [
              'You are Cynthia doing a warm consult transfer for Builder Diddies.',
              'The original caller is on hold. You are speaking only to the staff member who just answered.',
              '1. Confirm they are human and available (not voicemail).',
              '2. Give a one-sentence brief about who is calling and why.',
              '3. If they accept (yes / put them through / ready), call transferSuccessful.',
              '4. If they decline, are busy, or you hit voicemail, call transferCancel.',
              'Keep it under three short spoken sentences. British English. Never say TradePro.',
            ].join('\n'),
          },
        ],
      },
    },
  };
}

export function buildTransferDestination(opts: {
  number: string;
  description: string;
  customerMessage?: string;
  department?: string;
  reason?: string;
}): Record<string, unknown> {
  return {
    type: 'number',
    number: toE164Uk(opts.number),
    message: opts.customerMessage
      || 'Give me one moment — I am putting you on a short hold while I get someone on the line.',
    description: opts.description,
    transferPlan: buildWarmTransferPlan({
      department: opts.department || opts.description,
      reason: opts.reason,
    }),
  };
}

export function transferDestinationsFromEnv(): Array<Record<string, unknown>> {
  const destinations: Array<Record<string, unknown>> = [];
  const def = transferNumberFor('general');
  if (def) {
    destinations.push(buildTransferDestination({
      number: def,
      description: 'Default office transfer',
      department: 'the team',
      customerMessage: 'Give me one moment — I am putting you on a short hold while I get the team on the line.',
    }));
  }
  for (const dept of ['sales', 'projects', 'recruitment', 'accounts'] as const) {
    const n = transferNumberFor(dept);
    if (n) {
      destinations.push(buildTransferDestination({
        number: n,
        description: dept,
        department: dept,
        customerMessage: `Give me one moment — I am putting you on a short hold while I get ${dept} on the line.`,
      }));
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

/** Full warm destination for transferToHuman webhook / tool results. */
export function resolveTransferDestination(opts?: {
  department?: string;
  reason?: string;
  message?: string;
}): Record<string, unknown> | null {
  const dept = String(opts?.department || 'general').toLowerCase();
  const number = resolveTransferNumber(dept);
  if (!number) return null;
  const label = (DEPTS as readonly string[]).includes(dept) ? dept : 'general';
  return buildTransferDestination({
    number,
    description: label === 'general' ? 'Default office transfer' : label,
    department: label === 'general' ? 'the team' : label,
    reason: opts?.reason || opts?.message,
    customerMessage: 'Give me one moment — I am putting you on a short hold while I get someone on the line.',
  });
}
