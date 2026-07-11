import * as msal from '@azure/msal-node';
import type { MailProviderAdapter, MailProviderConfig, TokenSet } from '../types';
import { getProviderOAuthConfig, getRedirectUri } from '../oauth-config';

const MS_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access',
  'openid',
  'email',
  'profile',
];

export function createMicrosoftProvider(): MailProviderAdapter {
  const cfg = getProviderOAuthConfig('microsoft');
  const redirectUri = getRedirectUri();
  const authority = `https://login.microsoftonline.com/${cfg.tenantId || 'common'}`;

  function pca(): msal.ConfidentialClientApplication {
    return new msal.ConfidentialClientApplication({
      auth: {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        authority,
      },
    });
  }

  return {
    id: 'microsoft',
    getConfig(): MailProviderConfig {
      return {
        imap: { host: 'outlook.office365.com', port: 993, secure: true },
        smtp: { host: 'smtp.office365.com', port: 587, secure: false },
      };
    },
    buildAuthUrl(state: string, loginHint?: string): string {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: MS_SCOPES.join(' '),
        state,
      });
      if (loginHint) params.set('login_hint', loginHint);
      return `${authority}/oauth2/v2.0/authorize?${params.toString()}`;
    },
    async exchangeCode(code: string): Promise<TokenSet> {
      const result = await pca().acquireTokenByCode({
        code,
        scopes: MS_SCOPES,
        redirectUri,
      });
      if (!result?.accessToken) throw new Error('Microsoft OAuth failed');
      const email = result.account?.username;
      const cache = pca().getTokenCache().serialize();
      let refreshToken = '';
      try {
        const parsed = JSON.parse(cache) as { RefreshToken?: Record<string, { secret: string }> };
        const entries = Object.values(parsed.RefreshToken ?? {});
        refreshToken = entries[0]?.secret ?? '';
      } catch {
        refreshToken = '';
      }
      if (!refreshToken) {
        throw new Error('Microsoft OAuth did not return a refresh token — ensure offline_access scope');
      }
      return {
        accessToken: result.accessToken,
        refreshToken,
        expiresAt: result.expiresOn ?? new Date(Date.now() + 3600 * 1000),
        email,
        scope: result.scopes?.join(' '),
      };
    },
    async refreshToken(refreshToken: string): Promise<TokenSet> {
      const body = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: MS_SCOPES.join(' '),
      });
      const res = await fetch(`${authority}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await res.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (!res.ok || !data.access_token) {
        throw new Error(data.error || 'Microsoft token refresh failed');
      }
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
      };
    },
    async revokeToken(_refreshToken: string): Promise<void> {
      // Microsoft has no simple revoke for refresh tokens in all tenant configs
    },
  };
}
