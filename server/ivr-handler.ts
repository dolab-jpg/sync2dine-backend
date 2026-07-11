/**
 * Optional IVR phone trees — enabled with IVR_ENABLED=1.
 */
import { getAgentSettings, saveCall, getCallById } from './data-store';

export interface IvrMenuOption {
  digit: string;
  label: string;
  route: 'sales' | 'foreman' | 'transfer' | 'voicemail';
}

export interface IvrTreeConfig {
  greeting: string;
  options: IvrMenuOption[];
}

const DEFAULT_IVR_TREE: IvrTreeConfig = {
  greeting: 'Welcome to TradePro. Press 1 for quotes and sales. Press 2 for site and projects. Press 3 to speak to the office. Press 9 to leave a message.',
  options: [
    { digit: '1', label: 'Quotes and sales', route: 'sales' },
    { digit: '2', label: 'Site and projects', route: 'foreman' },
    { digit: '3', label: 'Office', route: 'transfer' },
    { digit: '9', label: 'Voicemail', route: 'voicemail' },
  ],
};

export function isIvrEnabled(): boolean {
  return process.env.IVR_ENABLED === '1' || process.env.IVR_ENABLED === 'true';
}

export function getIvrTree(): IvrTreeConfig {
  const settings = getAgentSettings();
  const custom = settings.ivrTree as IvrTreeConfig | undefined;
  if (custom?.options?.length) return custom;
  return DEFAULT_IVR_TREE;
}

export function parseDtmfInput(speechResult?: string, digits?: string): string | null {
  const raw = (digits ?? speechResult ?? '').trim();
  if (!raw) return null;
  const match = raw.match(/[0-9#*]/);
  return match ? match[0] : null;
}

export interface IvrTurnResult {
  speak: string;
  gather?: boolean;
  transferTo?: string;
  hangup?: boolean;
  ivrRoute?: 'sales' | 'foreman' | 'transfer' | 'voicemail' | 'menu';
}

export function handleIvrTurn(
  callId: string,
  speechResult?: string,
  digits?: string,
  isStart = false,
): IvrTurnResult | null {
  if (!isIvrEnabled()) return null;

  const call = getCallById(callId);
  const metadata = (call?.metadata ?? {}) as Record<string, unknown>;
  const tree = getIvrTree();
  const dtmf = parseDtmfInput(speechResult, digits);

  if (isStart && !dtmf) {
    saveCall({
      id: callId,
      metadata: { ...metadata, ivrState: 'menu' },
    });
    return { speak: tree.greeting, gather: true, ivrRoute: 'menu' };
  }

  if (!dtmf) {
    return {
      speak: 'Sorry, I did not catch that. ' + tree.greeting,
      gather: true,
      ivrRoute: 'menu',
    };
  }

  const option = tree.options.find((o) => o.digit === dtmf);
  if (!option) {
    return {
      speak: `Invalid option. ${tree.greeting}`,
      gather: true,
      ivrRoute: 'menu',
    };
  }

  saveCall({
    id: callId,
    metadata: { ...metadata, ivrState: 'routed', ivrRoute: option.route, ivrDigit: dtmf },
  });

  if (option.route === 'transfer') {
    const transferNumber = process.env.VOICE_TRANSFER_NUMBER ?? '';
    return {
      speak: transferNumber
        ? 'Connecting you to the office now.'
        : 'The office is unavailable — please leave a message after the tone.',
      transferTo: transferNumber || undefined,
      gather: !transferNumber,
      ivrRoute: 'transfer',
    };
  }

  if (option.route === 'voicemail') {
    return {
      speak: 'Please leave your message after the tone. We will call you back.',
      gather: true,
      ivrRoute: 'voicemail',
    };
  }

  if (option.route === 'foreman') {
    return {
      speak: 'Connecting you to site support. How can we help with your project?',
      gather: true,
      ivrRoute: 'foreman',
    };
  }

  return {
    speak: 'Connecting you to sales. Tell us about the job and we will help with a quote.',
    gather: true,
    ivrRoute: 'sales',
  };
}

export function getIvrRouteForCall(callId: string): string | null {
  const call = getCallById(callId);
  const route = (call?.metadata as Record<string, unknown> | undefined)?.ivrRoute;
  return typeof route === 'string' ? route : null;
}
