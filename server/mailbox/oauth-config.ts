import type { IncomingMessage } from 'http';
import type { MailProviderId } from './types';
import { getEmailOAuthSecrets } from '../integration-secrets';

export function getRedirectUri(): string {
  const base = (
    process.env.MAILBOX_OAUTH_REDIRECT_BASE
    || process.env.APP_BASE_URL
    || `http://localhost:${process.env.PORT || 3001}`
  ).replace(/\/$/, '');
  return `${base}/api/mailbox/callback`;
}

export function getProviderOAuthConfig(provider: MailProviderId): {
  clientId: string;
  clientSecret: string;
  tenantId?: string;
} {
  if (provider === 'google') {
    const secrets = getEmailOAuthSecrets();
    return {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || secrets.googleClientId || '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || secrets.googleClientSecret || '',
    };
  }
  if (provider === 'microsoft') {
    const secrets = getEmailOAuthSecrets();
    return {
      clientId: process.env.MICROSOFT_OAUTH_CLIENT_ID || secrets.microsoftClientId || '',
      clientSecret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET || secrets.microsoftClientSecret || '',
      tenantId: process.env.MICROSOFT_OAUTH_TENANT_ID || secrets.microsoftTenantId || 'common',
    };
  }
  if (provider === 'yahoo') {
    const secrets = getEmailOAuthSecrets();
    return {
      clientId: process.env.YAHOO_OAUTH_CLIENT_ID || secrets.yahooClientId || '',
      clientSecret: process.env.YAHOO_OAUTH_CLIENT_SECRET || secrets.yahooClientSecret || '',
    };
  }
  return { clientId: '', clientSecret: '' };
}

export function isMailboxMockMode(): boolean {
  if (process.env.MAILBOX_FORCE_MOCK === 'true') return true;
  if (process.env.MAILBOX_MOCK_MODE === 'true') return true;
  if (process.env.MAILBOX_MOCK_MODE === 'false' || process.env.INTEGRATIONS_MOCK_MODE === 'false') {
    return false;
  }
  // Client credentials on disk/env → prefer live OAuth (Save now mirrors secrets here).
  if (hasAnyMailboxOAuthConfigured()) return false;
  return process.env.INTEGRATIONS_MOCK_MODE === 'true';
}

export function hasProviderOAuthConfigured(provider: MailProviderId): boolean {
  const cfg = getProviderOAuthConfig(provider);
  return Boolean(cfg.clientId?.trim() && cfg.clientSecret?.trim());
}

export function hasGoogleOAuthConfigured(): boolean {
  return hasProviderOAuthConfigured('google');
}

export function hasAnyMailboxOAuthConfigured(): boolean {
  return (
    hasProviderOAuthConfigured('google')
    || hasProviderOAuthConfigured('microsoft')
    || hasProviderOAuthConfigured('yahoo')
  );
}

export function shouldUseLiveMailbox(req?: IncomingMessage, provider?: MailProviderId): boolean {
  if (isMailboxMockMode()) {
    const liveHeader = req?.headers?.['x-mailbox-live'];
    if (liveHeader !== 'true') return false;
    if (provider) return hasProviderOAuthConfigured(provider);
    return hasAnyMailboxOAuthConfigured();
  }
  return true;
}

export function encodeOAuthState(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeOAuthState(state: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
