import type { MailProviderAdapter, MailProviderConfig, TokenSet } from '../types';
import { getProviderOAuthConfig, getRedirectUri } from '../oauth-config';

const YAHOO_AUTH = 'https://api.login.yahoo.com/oauth2/request_auth';
const YAHOO_TOKEN = 'https://api.login.yahoo.com/oauth2/get_token';
const YAHOO_SCOPES = ['mail-r', 'mail-w'];

export function createYahooProvider(): MailProviderAdapter {
  const cfg = getProviderOAuthConfig('yahoo');
  const redirectUri = getRedirectUri();

  return {
    id: 'yahoo',
    getConfig(): MailProviderConfig {
      return {
        imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
        smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
      };
    },
    buildAuthUrl(state: string, loginHint?: string): string {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: YAHOO_SCOPES.join(' '),
        state,
      });
      if (loginHint) params.set('login_hint', loginHint);
      return `${YAHOO_AUTH}?${params.toString()}`;
    },
    async exchangeCode(code: string): Promise<TokenSet> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      });
      const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
      const res = await fetch(YAHOO_TOKEN, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${auth}`,
        },
        body: body.toString(),
      });
      const data = await res.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (!res.ok || !data.access_token || !data.refresh_token) {
        throw new Error(data.error || 'Yahoo OAuth failed');
      }
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
      };
    },
    async refreshToken(refreshToken: string): Promise<TokenSet> {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
      const res = await fetch(YAHOO_TOKEN, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${auth}`,
        },
        body: body.toString(),
      });
      const data = await res.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (!res.ok || !data.access_token) {
        throw new Error(data.error || 'Yahoo token refresh failed');
      }
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
      };
    },
    async revokeToken(_refreshToken: string): Promise<void> {
      // Yahoo revoke optional
    },
  };
}
