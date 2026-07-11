import type { MailProviderAdapter, MailProviderId } from '../types';
import { createGoogleProvider } from './google';
import { createMicrosoftProvider } from './microsoft';
import { createYahooProvider } from './yahoo';

export function getProvider(id: MailProviderId): MailProviderAdapter {
  switch (id) {
    case 'google':
      return createGoogleProvider();
    case 'microsoft':
      return createMicrosoftProvider();
    case 'yahoo':
      return createYahooProvider();
    default:
      return createGoogleProvider();
  }
}

export function isProviderConfigured(id: MailProviderId): boolean {
  const p = getProvider(id);
  try {
    const cfg = p.buildAuthUrl('test');
    return cfg.length > 10;
  } catch {
    return false;
  }
}
