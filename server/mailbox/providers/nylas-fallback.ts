/**
 * Optional Nylas fallback adapter — stub for future CASA-delayed production launch.
 * Implements same MailProviderAdapter interface; wire via MAILBOX_PROVIDER=nylas.
 */
import type { MailProviderAdapter, MailProviderConfig, TokenSet } from '../types';

export function createNylasFallbackProvider(): MailProviderAdapter {
  return {
    id: 'nylas',
    getConfig(): MailProviderConfig {
      return {
        imap: { host: 'imap.gmail.com', port: 993, secure: true },
        smtp: { host: 'smtp.gmail.com', port: 587, secure: false },
      };
    },
    buildAuthUrl(state: string): string {
      const apiKey = process.env.NYLAS_API_KEY || '';
      const clientId = process.env.NYLAS_CLIENT_ID || '';
      const redirect = process.env.MAILBOX_OAUTH_REDIRECT_BASE || 'http://localhost:3001';
      return `https://api.us.nylas.com/v3/connect/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(`${redirect}/api/mailbox/callback`)}&state=${state}&response_type=code`;
    },
    async exchangeCode(_code: string): Promise<TokenSet> {
      throw new Error('Nylas fallback not configured — set NYLAS_API_KEY and NYLAS_CLIENT_ID');
    },
    async refreshToken(_refreshToken: string): Promise<TokenSet> {
      throw new Error('Nylas fallback not implemented');
    },
    async revokeToken(_refreshToken: string): Promise<void> {
      // noop
    },
  };
}
