import type { IncomingMessage, ServerResponse } from 'http';
import {
  createCalendarConnection,
  deleteCalendarConnection,
  getActiveCalendarConnection,
  getCalendarConnection,
  listCalendarConnections,
} from './calendar/calendar-store';
import {
  buildCalendarAuthUrl,
  createGoogleCalendarEvent,
  exchangeCalendarCode,
  getCalendarRedirectUri,
  getGoogleCalendarOAuthCredentials,
  hasGoogleCalendarOAuthConfigured,
  revokeCalendarTokens,
  saveCalendarTokens,
} from './calendar/google-calendar';
import { decodeOAuthState, encodeOAuthState } from './mailbox/oauth-config';
import { sendOAuthPopupResult } from './oauth-popup';
import { verifyToken, extractBearerToken } from './auth';
import { BDIDDIES_HOME_ORG_ID } from './home-org';
import { saveIntegrationSecrets } from './integration-secrets';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseAuth(req: IncomingMessage): { userId: string; orgId: string; unauthorized?: boolean } {
  const headerUser = req.headers['x-user-id']?.toString();
  const headerOrg = req.headers['x-org-id']?.toString();
  const token = extractBearerToken(req);
  const payload = token ? verifyToken(token) : null;
  const authEnforced = process.env.AUTH_ENFORCED === '1' || process.env.AUTH_ENFORCED === 'true';

  if (authEnforced && !payload) {
    return { userId: '', orgId: '', unauthorized: true };
  }

  const userId = payload?.userId || headerUser || 'default-user';
  const orgId =
    (payload?.role === 'platform_owner' ? headerOrg : null)
    || payload?.orgId
    || headerOrg
    || BDIDDIES_HOME_ORG_ID;
  return { userId, orgId };
}

export async function handleCalendarRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (!pathname.startsWith('/api/calendar')) return false;

  if (pathname === '/api/calendar/connect' && req.method === 'GET') {
    const { userId, orgId, unauthorized } = parseAuth(req);
    // #region agent log
    fetch('http://127.0.0.1:7756/ingest/45011e36-ac12-4dbc-b7c1-e1827334fcf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'732d78'},body:JSON.stringify({sessionId:'732d78',runId:'pre-fix',hypothesisId:'A',location:'calendar-routes.ts:connect',message:'calendar connect hit',data:{unauthorized:Boolean(unauthorized),configured:hasGoogleCalendarOAuthConfigured(),redirectUri:getCalendarRedirectUri(),hasAppOrigin:Boolean(url.searchParams.get('appOrigin'))},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (unauthorized) {
      sendJson(res, 401, { error: 'Unauthorized — sign in required for calendar' });
      return true;
    }

    if (!hasGoogleCalendarOAuthConfigured()) {
      // #region agent log
      fetch('http://127.0.0.1:7756/ingest/45011e36-ac12-4dbc-b7c1-e1827334fcf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'732d78'},body:JSON.stringify({sessionId:'732d78',runId:'pre-fix',hypothesisId:'B',location:'calendar-routes.ts:notConfigured',message:'oauth not configured on server',data:{redirectUri:getCalendarRedirectUri()},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      sendJson(res, 400, {
        error: 'Add Google Client ID/Secret under Integrations → Google Calendar (or Mailbox OAuth)',
      });
      return true;
    }

    const loginHint = url.searchParams.get('loginHint') ?? undefined;
    const appOrigin = url.searchParams.get('appOrigin') || undefined;
    const state = encodeOAuthState({ userId, orgId, popup: true, appOrigin, ts: Date.now() });
    try {
      const authUrl = buildCalendarAuthUrl(state, loginHint);
      // #region agent log
      fetch('http://127.0.0.1:7756/ingest/45011e36-ac12-4dbc-b7c1-e1827334fcf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'732d78'},body:JSON.stringify({sessionId:'732d78',runId:'pre-fix',hypothesisId:'C',location:'calendar-routes.ts:authUrl',message:'auth url built',data:{redirectUri:getCalendarRedirectUri(),hasAuthUrl:Boolean(authUrl),includesRedirect:authUrl.includes(encodeURIComponent(getCalendarRedirectUri()))},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      sendJson(res, 200, {
        authUrl,
        redirectUri: getCalendarRedirectUri(),
        popup: true,
      });
    } catch (err) {
      sendJson(res, 400, {
        error: err instanceof Error ? err.message : 'Calendar OAuth not configured',
      });
    }
    return true;
  }

  if (pathname === '/api/calendar/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const stateRaw = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const state = stateRaw ? decodeOAuthState(stateRaw) : null;
    const targetOrigin = typeof state?.appOrigin === 'string' ? state.appOrigin : '*';
    // #region agent log
    fetch('http://127.0.0.1:7756/ingest/45011e36-ac12-4dbc-b7c1-e1827334fcf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'732d78'},body:JSON.stringify({sessionId:'732d78',runId:'pre-fix',hypothesisId:'E',location:'calendar-routes.ts:callback',message:'calendar callback hit',data:{hasCode:Boolean(code),hasState:Boolean(stateRaw),oauthError:error||null,targetOrigin},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    if (error || !code || !stateRaw) {
      sendOAuthPopupResult(res, 'calendar_oauth', {
        ok: false,
        error: error || 'OAuth cancelled or missing code',
        provider: 'google',
      }, targetOrigin);
      return true;
    }

    const userId = String(state?.userId ?? 'default-user');
    const orgId = String(state?.orgId ?? 'default');
    const { calendarId } = getGoogleCalendarOAuthCredentials();

    try {
      const tokens = await exchangeCalendarCode(code);
      const conn = createCalendarConnection({
        orgId,
        userId,
        emailAddress: tokens.email || 'unknown@calendar.local',
        calendarId,
        status: 'connected',
      });
      await saveCalendarTokens(conn.id, tokens);
      // #region agent log
      fetch('http://127.0.0.1:7756/ingest/45011e36-ac12-4dbc-b7c1-e1827334fcf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'732d78'},body:JSON.stringify({sessionId:'732d78',runId:'pre-fix',hypothesisId:'E',location:'calendar-routes.ts:exchangeOk',message:'token exchange ok',data:{hasEmail:Boolean(tokens.email),calendarId},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      sendOAuthPopupResult(res, 'calendar_oauth', {
        ok: true,
        email: conn.emailAddress,
        provider: 'google',
      }, targetOrigin);
    } catch (err) {
      // #region agent log
      fetch('http://127.0.0.1:7756/ingest/45011e36-ac12-4dbc-b7c1-e1827334fcf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'732d78'},body:JSON.stringify({sessionId:'732d78',runId:'pre-fix',hypothesisId:'E',location:'calendar-routes.ts:exchangeFail',message:'token exchange failed',data:{err:err instanceof Error?err.message:String(err)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      sendOAuthPopupResult(res, 'calendar_oauth', {
        ok: false,
        error: err instanceof Error ? err.message : 'OAuth failed',
        provider: 'google',
      }, targetOrigin);
    }
    return true;
  }

  if (pathname === '/api/calendar/connection' && req.method === 'GET') {
    const { userId, orgId, unauthorized } = parseAuth(req);
    if (unauthorized) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const connection = getActiveCalendarConnection(orgId, userId) || null;
    sendJson(res, 200, {
      connection,
      configured: hasGoogleCalendarOAuthConfigured(),
      redirectUri: getCalendarRedirectUri(),
      connections: listCalendarConnections(orgId, userId),
    });
    return true;
  }

  if (pathname === '/api/calendar/connection' && req.method === 'DELETE') {
    const { userId, orgId, unauthorized } = parseAuth(req);
    if (unauthorized) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const conn = getActiveCalendarConnection(orgId, userId);
    if (!conn) {
      sendJson(res, 404, { error: 'No calendar connection' });
      return true;
    }
    await revokeCalendarTokens(conn.id);
    deleteCalendarConnection(conn.id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/calendar/events' && req.method === 'POST') {
    const { userId, orgId, unauthorized } = parseAuth(req);
    if (unauthorized) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    let payload: {
      title?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
      attendees?: string[];
      calendarId?: string;
      connectionId?: string;
    };
    try {
      payload = JSON.parse(await readBody(req)) as typeof payload;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }

    const title = String(payload.title || '').trim();
    const start = String(payload.start || '').trim();
    const end = String(payload.end || '').trim();
    if (!title || !start || !end) {
      sendJson(res, 400, { error: 'title, start, and end are required' });
      return true;
    }

    const conn = payload.connectionId
      ? getCalendarConnection(payload.connectionId)
      : (getActiveCalendarConnection(orgId, userId) || getActiveCalendarConnection(orgId));

    if (!conn || conn.status !== 'connected') {
      sendJson(res, 404, { error: 'Google Calendar not connected', code: 'not_connected' });
      return true;
    }
    if (conn.orgId !== orgId) {
      sendJson(res, 403, { error: 'Forbidden' });
      return true;
    }

    try {
      const event = await createGoogleCalendarEvent(conn.id, {
        title,
        start,
        end,
        description: payload.description,
        location: payload.location,
        attendees: payload.attendees,
        calendarId: payload.calendarId,
      });
      sendJson(res, 200, { ok: true, event });
    } catch (err) {
      sendJson(res, 400, {
        error: err instanceof Error ? err.message : 'Failed to create calendar event',
      });
    }
    return true;
  }

  if (pathname === '/api/calendar/secrets' && req.method === 'POST') {
    const { unauthorized } = parseAuth(req);
    if (unauthorized) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    let values: Record<string, string>;
    try {
      values = JSON.parse(await readBody(req)) as Record<string, string>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    saveIntegrationSecrets('google_calendar', values);
    sendJson(res, 200, {
      ok: true,
      configured: hasGoogleCalendarOAuthConfigured(),
      redirectUri: getCalendarRedirectUri(),
    });
    return true;
  }

  sendJson(res, 404, { error: 'Calendar route not found' });
  return true;
}
