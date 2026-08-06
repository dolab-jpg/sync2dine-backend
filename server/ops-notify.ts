/**
 * Fan-out ops notifications to email, SMS, and Trae webhook.
 */
import { getOpsContacts } from './ops-contacts-store';

export type OpsNotifyEvent = 'api_down' | 'api_recovered' | 'ops_alert' | 'test';

export type OpsNotifyPayload = {
  source: 'sync2dine-ops';
  event: OpsNotifyEvent;
  severity: 'critical' | 'high' | 'info';
  title: string;
  message: string;
  at: string;
  healthUrl: string;
  code?: string;
  orgId?: string;
};

export type OpsNotifyResult = {
  email?: { ok: boolean; error?: string; via?: string; from?: string };
  sms?: { ok: boolean; error?: string; stub?: boolean };
  webhook?: { ok: boolean; error?: string; status?: number };
};

function buildPayload(input: {
  event: OpsNotifyEvent;
  severity: 'critical' | 'high' | 'info';
  title: string;
  message: string;
  code?: string;
  orgId?: string;
}): OpsNotifyPayload {
  return {
    source: 'sync2dine-ops',
    event: input.event,
    severity: input.severity,
    title: input.title,
    message: input.message,
    at: new Date().toISOString(),
    healthUrl: 'https://app.sync2dine.io/health',
    code: input.code,
    orgId: input.orgId,
  };
}

async function postTraeWebhook(
  url: string,
  payload: OpsNotifyPayload,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'sync2dine-ops-notify/1' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `webhook_http_${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'webhook_failed' };
  }
}

export async function sendOpsNotify(input: {
  event: OpsNotifyEvent;
  severity: 'critical' | 'high' | 'info';
  title: string;
  message: string;
  code?: string;
  orgId?: string;
  /** When true, skip channels that are empty instead of failing. */
  channels?: { email?: boolean; sms?: boolean; webhook?: boolean };
}): Promise<{ payload: OpsNotifyPayload; results: OpsNotifyResult }> {
  const contacts = getOpsContacts();
  const payload = buildPayload(input);
  const want = {
    email: input.channels?.email !== false,
    sms: input.channels?.sms !== false,
    webhook: input.channels?.webhook !== false,
  };
  const results: OpsNotifyResult = {};

  if (want.email && contacts.alertEmail) {
    try {
      const { sendOpsAlertEmail } = await import('./ops-gmail-send');
      const r = await sendOpsAlertEmail({
        to: contacts.alertEmail,
        subject: `[Sync2Dine ${payload.severity}] ${payload.title}`,
        text: [
          payload.title,
          '',
          payload.message,
          '',
          `Event: ${payload.event}`,
          `At: ${payload.at}`,
          `Health: ${payload.healthUrl}`,
          payload.code ? `Code: ${payload.code}` : '',
          payload.orgId ? `Org: ${payload.orgId}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      results.email = r.ok
        ? { ok: true, via: r.via, from: r.from }
        : { ok: false, error: r.error, via: r.via };
    } catch (err) {
      results.email = { ok: false, error: err instanceof Error ? err.message : 'email_failed' };
    }
  }

  if (want.sms && contacts.alertPhone) {
    try {
      const { sendTwilioSms } = await import('./telephony/twilioAdapter');
      const body = `Sync2Dine ${payload.severity}: ${payload.title} — ${payload.message}`.slice(0, 300);
      const r = await sendTwilioSms(contacts.alertPhone, body);
      results.sms = { ok: true, stub: Boolean(r.stub) };
    } catch (err) {
      results.sms = { ok: false, error: err instanceof Error ? err.message : 'sms_failed' };
    }
  }

  if (want.webhook && contacts.traeWebhookUrl) {
    results.webhook = await postTraeWebhook(contacts.traeWebhookUrl, payload);
  }

  console.error(
    `[ops-notify] event=${payload.event} email=${results.email?.ok ?? 'skip'} sms=${results.sms?.ok ?? 'skip'} webhook=${results.webhook?.ok ?? 'skip'}`,
  );
  return { payload, results };
}
