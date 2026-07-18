import { OAuth2Client } from 'google-auth-library';
import { getEmailOAuthSecrets, getIntegrationSecrets } from '../integration-secrets';
import { encrypt, decrypt } from '../mailbox/crypto';
import {
  getCalendarConnection,
  getCalendarTokenRow,
  saveCalendarTokenRow,
  deleteCalendarTokenRow,
} from './calendar-store';

export const CALENDAR_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
];

export function getCalendarRedirectUri(): string {
  const base = (
    process.env.MAILBOX_OAUTH_REDIRECT_BASE
    || process.env.APP_BASE_URL
    || `http://localhost:${process.env.PORT || 3001}`
  ).replace(/\/$/, '');
  return `${base}/api/calendar/callback`;
}

export function getGoogleCalendarOAuthCredentials(): { clientId: string; clientSecret: string; calendarId: string } {
  const cal = getIntegrationSecrets('google_calendar');
  const mail = getEmailOAuthSecrets();
  const clientId =
    process.env.GOOGLE_CALENDAR_CLIENT_ID
    || process.env.GOOGLE_OAUTH_CLIENT_ID
    || cal.clientId
    || mail.googleClientId
    || '';
  const clientSecret =
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    || process.env.GOOGLE_OAUTH_CLIENT_SECRET
    || cal.clientSecret
    || mail.googleClientSecret
    || '';
  const calendarId = cal.calendarId?.trim() || 'primary';
  return { clientId, clientSecret, calendarId };
}

export function hasGoogleCalendarOAuthConfigured(): boolean {
  const { clientId, clientSecret } = getGoogleCalendarOAuthCredentials();
  return Boolean(clientId.trim() && clientSecret.trim());
}

function oauthClient(): OAuth2Client {
  const { clientId, clientSecret } = getGoogleCalendarOAuthCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('Google Calendar OAuth not configured — add Client ID/Secret under Integrations');
  }
  return new OAuth2Client(clientId, clientSecret, getCalendarRedirectUri());
}

export function buildCalendarAuthUrl(state: string, loginHint?: string): string {
  const oauth = oauthClient();
  return oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: CALENDAR_SCOPES,
    state,
    login_hint: loginHint,
  });
}

export interface CalendarTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  email?: string;
  scope?: string;
}

export async function exchangeCalendarCode(code: string): Promise<CalendarTokenSet> {
  const oauth = oauthClient();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('Google Calendar OAuth did not return access and refresh tokens');
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
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600 * 1000),
    email,
    scope: tokens.scope,
  };
}

export async function saveCalendarTokens(connectionId: string, tokens: CalendarTokenSet): Promise<void> {
  saveCalendarTokenRow({
    connectionId,
    accessTokenEnc: encrypt(tokens.accessToken),
    refreshTokenEnc: encrypt(tokens.refreshToken),
    expiresAt: tokens.expiresAt.toISOString(),
    scope: tokens.scope,
    updatedAt: new Date().toISOString(),
  });
}

const BUFFER_MS = 5 * 60 * 1000;
const refreshLocks = new Map<string, Promise<string>>();

async function refreshAccessToken(connectionId: string, refreshToken: string): Promise<CalendarTokenSet> {
  const oauth = oauthClient();
  oauth.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth.refreshAccessToken();
  if (!credentials.access_token) {
    throw new Error('Failed to refresh Google Calendar access token');
  }
  return {
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token || refreshToken,
    expiresAt: new Date(credentials.expiry_date ?? Date.now() + 3600 * 1000),
    scope: credentials.scope,
  };
}

export async function getValidCalendarAccessToken(connectionId: string): Promise<string> {
  const row = getCalendarTokenRow(connectionId);
  if (!row) throw new Error('No calendar tokens for connection');

  const expiresAt = new Date(row.expiresAt).getTime();
  if (expiresAt - Date.now() > BUFFER_MS) {
    return decrypt(row.accessTokenEnc);
  }

  const existing = refreshLocks.get(connectionId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const fresh = getCalendarTokenRow(connectionId);
      if (!fresh) throw new Error('No calendar tokens for connection');
      const freshExpiry = new Date(fresh.expiresAt).getTime();
      if (freshExpiry - Date.now() > BUFFER_MS) {
        return decrypt(fresh.accessTokenEnc);
      }
      const refreshToken = decrypt(fresh.refreshTokenEnc);
      const tokens = await refreshAccessToken(connectionId, refreshToken);
      await saveCalendarTokens(connectionId, tokens);
      return tokens.accessToken;
    } finally {
      refreshLocks.delete(connectionId);
    }
  })();

  refreshLocks.set(connectionId, promise);
  return promise;
}

export async function revokeCalendarTokens(connectionId: string): Promise<void> {
  const row = getCalendarTokenRow(connectionId);
  if (row) {
    try {
      const oauth = oauthClient();
      await oauth.revokeToken(decrypt(row.refreshTokenEnc)).catch(() => undefined);
    } catch {
      // ignore
    }
  }
  deleteCalendarTokenRow(connectionId);
}

export interface CreateCalendarEventInput {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  calendarId?: string;
}

export async function createGoogleCalendarEvent(
  connectionId: string,
  input: CreateCalendarEventInput,
): Promise<{ id: string; htmlLink?: string }> {
  const conn = getCalendarConnection(connectionId);
  if (!conn || conn.status !== 'connected') {
    throw new Error('Google Calendar not connected');
  }
  const accessToken = await getValidCalendarAccessToken(connectionId);
  const calendarId = encodeURIComponent(input.calendarId || conn.calendarId || 'primary');

  const startDate = new Date(input.start);
  const endDate = new Date(input.end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error('Invalid start or end time');
  }

  const body: Record<string, unknown> = {
    summary: input.title,
    description: input.description || undefined,
    location: input.location || undefined,
    start: { dateTime: startDate.toISOString() },
    end: { dateTime: endDate.toISOString() },
  };
  if (input.attendees?.length) {
    body.attendees = input.attendees.filter(Boolean).map((email) => ({ email }));
  }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json().catch(() => ({})) as { id?: string; htmlLink?: string; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(data.error?.message || `Google Calendar API error (${res.status})`);
  }
  if (!data.id) throw new Error('Google Calendar did not return an event id');
  return { id: data.id, htmlLink: data.htmlLink };
}
