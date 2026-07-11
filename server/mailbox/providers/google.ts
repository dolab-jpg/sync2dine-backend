import { OAuth2Client } from 'google-auth-library';
import type { MailProviderAdapter, MailProviderConfig, TokenSet } from '../types';
import { getProviderOAuthConfig, getRedirectUri } from '../oauth-config';

const GOOGLE_SCOPES = ['https://mail.google.com/'];

export function createGoogleProvider(): MailProviderAdapter {
  const cfg = getProviderOAuthConfig('google');
  const redirectUri = getRedirectUri();

  function client(): OAuth2Client {
    return new OAuth2Client(cfg.clientId, cfg.clientSecret, redirectUri);
  }

  return {
    id: 'google',
    getConfig(): MailProviderConfig {
      return {
        imap: { host: 'imap.gmail.com', port: 993, secure: true },
        smtp: { host: 'smtp.gmail.com', port: 587, secure: false },
      };
    },
    buildAuthUrl(state: string, loginHint?: string): string {
      const oauth = client();
      return oauth.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: GOOGLE_SCOPES,
        state,
        login_hint: loginHint,
      });
    },
    async exchangeCode(code: string): Promise<TokenSet> {
      const oauth = client();
      const { tokens } = await oauth.getToken(code);
      if (!tokens.access_token || !tokens.refresh_token) {
        throw new Error('Google OAuth did not return access and refresh tokens');
      }
      oauth.setCredentials(tokens);
      let email: string | undefined;
      try {
        const info = await oauth.request<{ email: string }>({
          url: 'https://www.googleapis.com/oauth2/v2/userinfo',
        });
        email = info.data.email;
      } catch {
        email = undefined;
      }
      const expiresAt = new Date(
        tokens.expiry_date ?? Date.now() + 3600 * 1000
      );
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        email,
        scope: tokens.scope,
      };
    },
    async refreshToken(refreshToken: string): Promise<TokenSet> {
      const oauth = client();
      oauth.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await oauth.refreshAccessToken();
      if (!credentials.access_token) {
        throw new Error('Failed to refresh Google access token');
      }
      return {
        accessToken: credentials.access_token,
        refreshToken: credentials.refresh_token || refreshToken,
        expiresAt: new Date(credentials.expiry_date ?? Date.now() + 3600 * 1000),
        scope: credentials.scope,
      };
    },
    async revokeToken(refreshToken: string): Promise<void> {
      const oauth = client();
      await oauth.revokeToken(refreshToken).catch(() => undefined);
    },
  };
}
