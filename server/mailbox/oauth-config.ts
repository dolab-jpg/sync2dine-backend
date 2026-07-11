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
  if (process.env.INTEGRATIONS_MOCK_MODE === 'false' || process.env.MAILBOX_MOCK_MODE === 'false') {
    return false;
  }
  return true;
}

export function hasGoogleOAuthConfigured(): boolean {
  const secrets = getEmailOAuthSecrets();
  return Boolean(
    (process.env.GOOGLE_OAUTH_CLIENT_ID || secrets.googleClientId)
    && (process.env.GOOGLE_OAUTH_CLIENT_SECRET || secrets.googleClientSecret)
  );
}

export function shouldUseLiveMailbox(req?: IncomingMessage): boolean {
  if (isMailboxMockMode()) {
    const liveHeader = req?.headers?.['x-mailbox-live'];
    if (liveHeader === 'true' && hasGoogleOAuthConfigured()) return true;
    return false;
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
