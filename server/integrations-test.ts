import type { IncomingMessage, ServerResponse } from 'http';
import { saveIntegrationSecrets, getEmailOAuthSecrets } from './integration-secrets';
import { getProvider } from './mailbox/providers';
import { getRedirectUri } from './mailbox/oauth-config';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function handleIntegrationTest(
  req: IncomingMessage,
  res: ServerResponse,
  body: { integrationId: string; values: Record<string, string> }
) {
  const { integrationId, values } = body;

  try {
    if (integrationId === 'openai') {
      const apiKey = values.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey || String(apiKey).startsWith('••••')) {
        sendJson(res, 400, { success: false, message: 'OpenAI API key required', status: 'error' });
        return;
      }
      const { probeLLMConnection } = await import('./llm-connection');
      await probeLLMConnection('openai', apiKey);
      sendJson(res, 200, { success: true, message: 'Company AI Brain (OpenAI) connected', status: 'connected' });
      return;
    }

    if (integrationId === 'whatsapp') {
      const token = values.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
      const phoneId = values.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
      if (!token || !phoneId) {
        sendJson(res, 400, { success: false, message: 'Access token and Phone Number ID required', status: 'error' });
        return;
      }
      const response = await fetch(`https://graph.facebook.com/v21.0/${phoneId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const err = await response.text();
        sendJson(res, 400, { success: false, message: `Meta API error: ${err}`, status: 'error' });
        return;
      }
      sendJson(res, 200, { success: true, message: 'WhatsApp connection successful', status: 'connected' });
      return;
    }

    if (integrationId === 'email_resend') {
      if (!values.apiKey) {
        sendJson(res, 400, { success: false, message: 'API key required', status: 'error' });
        return;
      }
      const response = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${values.apiKey}` },
      });
      if (!response.ok) {
        sendJson(res, 400, { success: false, message: 'Resend API key invalid', status: 'error' });
        return;
      }
      sendJson(res, 200, { success: true, message: 'Resend connection successful', status: 'connected' });
      return;
    }

    if (integrationId === 'supabase') {
      const url = values.projectUrl || process.env.SUPABASE_URL;
      const key = values.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || values.anonKey || process.env.SUPABASE_ANON_KEY;
      if (!url || !key) {
        sendJson(res, 400, { success: false, message: 'Project URL and API key required', status: 'error' });
        return;
      }
      const { createClient } = await import('@supabase/supabase-js');
      const client = createClient(url, key);
      const { error } = await client.from('organizations').select('id').limit(1);
      if (error) {
        sendJson(res, 400, { success: false, message: `Supabase error: ${error.message}`, status: 'error' });
        return;
      }
      sendJson(res, 200, { success: true, message: 'Supabase connection successful', status: 'connected' });
      return;
    }

    if (integrationId === 'mongodb') {
      const connectionString = values.connectionString || process.env.MONGODB_CONNECTION_STRING;
      if (!connectionString?.trim()) {
        sendJson(res, 400, { success: false, message: 'Connection string required', status: 'error' });
        return;
      }
      const { testMongoConnection } = await import('./mongodb');
      const result = await testMongoConnection(connectionString, values.databaseName);
      if (!result.ok) {
        sendJson(res, 400, { success: false, message: result.error, status: 'error' });
        return;
      }
      sendJson(res, 200, {
        success: true,
        message: `Connected to database "${result.database}" (${result.collections.length} collections)`,
        status: 'connected',
      });
      return;
    }

    if (integrationId === 'webhook_server') {
      const base = values.baseUrl?.replace(/\/$/, '');
      const health = values.healthEndpoint || '/health';
      if (!base) {
        sendJson(res, 400, { success: false, message: 'Base URL required', status: 'error' });
        return;
      }
      const response = await fetch(`${base}${health}`);
      if (!response.ok) {
        sendJson(res, 400, { success: false, message: `Health check failed (${response.status})`, status: 'error' });
        return;
      }
      sendJson(res, 200, { success: true, message: 'Webhook server reachable', status: 'connected' });
      return;
    }

    if (integrationId === 'voice_telephony') {
      const provider = values.provider ?? process.env.TELEPHONY_PROVIDER ?? 'mock';
      if (provider === 'mock') {
        sendJson(res, 200, { success: true, message: 'Mock telephony provider ready', status: 'connected' });
        return;
      }
      if (provider === 'soho66') {
        const { soho66Adapter } = await import('./telephony/soho66Adapter');
        const result = await soho66Adapter.testConnection({
          provider: 'soho66',
          sipBridgeUrl: values.sipBridgeUrl ?? process.env.SOHO66_SIP_BRIDGE_URL,
        });
        sendJson(res, result.ok ? 200 : 400, {
          success: result.ok,
          message: result.message,
          status: result.ok ? 'connected' : 'error',
        });
        return;
      }
      const { twilioAdapter } = await import('./telephony/twilioAdapter');
      const result = await twilioAdapter.testConnection({
        provider: 'twilio',
        accountSid: values.accountSid,
        authToken: values.authToken,
        fromNumber: values.fromNumber,
      });
      sendJson(res, result.ok ? 200 : 400, {
        success: result.ok,
        message: result.message,
        status: result.ok ? 'connected' : 'error',
      });
      return;
    }

    if (integrationId === 'chatterbox_tts') {
      const baseUrl = (values.baseUrl || process.env.CHATTERBOX_BASE_URL)?.replace(/\/$/, '');
      const apiKey = values.apiKey || process.env.CHATTERBOX_API_KEY || '';
      if (!baseUrl) {
        sendJson(res, 400, { success: false, message: 'Base URL required', status: 'error' });
        return;
      }
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(`${baseUrl}/voices`, { headers });
      if (!response.ok) {
        sendJson(res, 400, { success: false, message: `Chatterbox API error (${response.status})`, status: 'error' });
        return;
      }
      sendJson(res, 200, { success: true, message: 'Chatterbox TTS connection successful', status: 'connected' });
      return;
    }

    if (integrationId === 'email_oauth') {
      saveIntegrationSecrets('email_oauth', values);
      const secrets = getEmailOAuthSecrets();
      const hasGoogle = Boolean(
        (process.env.GOOGLE_OAUTH_CLIENT_ID || secrets.googleClientId)
        && (process.env.GOOGLE_OAUTH_CLIENT_SECRET || secrets.googleClientSecret)
      );
      const hasMicrosoft = Boolean(
        (process.env.MICROSOFT_OAUTH_CLIENT_ID || secrets.microsoftClientId)
        && (process.env.MICROSOFT_OAUTH_CLIENT_SECRET || secrets.microsoftClientSecret)
      );
      const hasYahoo = Boolean(
        (process.env.YAHOO_OAUTH_CLIENT_ID || secrets.yahooClientId)
        && (process.env.YAHOO_OAUTH_CLIENT_SECRET || secrets.yahooClientSecret)
      );
      const mock = process.env.INTEGRATIONS_MOCK_MODE !== 'false' && !hasGoogle;
      if (mock && !hasGoogle && !hasMicrosoft && !hasYahoo) {
        sendJson(res, 200, { success: true, message: 'Mailbox OAuth ready (mock mode — add Google Client ID/Secret)', status: 'mock' });
        return;
      }
      if (hasGoogle) {
        try {
          const authUrl = getProvider('google').buildAuthUrl('integration-test');
          const redirectUri = getRedirectUri();
          const clientIdPresent = authUrl.includes('client_id=') && !authUrl.includes('client_id=&');
          if (!clientIdPresent) {
            sendJson(res, 400, { success: false, message: 'Google OAuth client ID invalid', status: 'error' });
            return;
          }
          sendJson(res, 200, {
            success: true,
            message: `Google OAuth SDK ready (redirect: ${redirectUri})`,
            status: 'connected',
            authUrlPreview: authUrl.split('&')[0] + '&...',
          });
          return;
        } catch (err) {
          sendJson(res, 400, {
            success: false,
            message: err instanceof Error ? err.message : 'Google OAuth SDK test failed',
            status: 'error',
          });
          return;
        }
      }
      sendJson(res, 200, {
        success: true,
        message: `Mailbox OAuth configured (${[hasMicrosoft && 'Microsoft', hasYahoo && 'Yahoo'].filter(Boolean).join(', ') || 'saved'})`,
        status: 'connected',
      });
      return;
    }

    // Generic: credentials saved
    sendJson(res, 200, {
      success: true,
      message: `${integrationId} credentials saved — live test not implemented yet`,
      status: 'connected',
    });
  } catch (err) {
    sendJson(res, 500, {
      success: false,
      message: err instanceof Error ? err.message : 'Test failed',
      status: 'error',
    });
  }
}
