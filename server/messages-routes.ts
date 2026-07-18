import type { IncomingMessage, ServerResponse } from 'http';
import { ensureEnglishForCustomerSend } from './outbound-english-guard';
import { getRequestOrgId } from './data-store';

interface SmtpConfig {
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
  fromEmail?: string;
  fromName?: string;
  secure?: string | boolean;
  apiKey?: string;
}

export interface SendPayload {
  channel?: string;
  provider?: string;
  to?: string;
  subject?: string;
  body?: string;
  html?: string;
  attachment?: { filename: string; mimeType: string; content: string };
  config?: SmtpConfig;
  /** Sender's known language, if already resolved by the caller (e.g. a worker's profile). */
  sourceLang?: string | null;
}

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

function resolveSmtp(config: SmtpConfig | undefined): Required<Pick<SmtpConfig, 'host' | 'username' | 'password' | 'fromEmail' | 'fromName'>> & { port: number } {
  const host = config?.host || process.env.SMTP_HOST || '';
  const port = Number(config?.port || process.env.SMTP_PORT || 587);
  const username = config?.username || process.env.SMTP_USERNAME || process.env.SMTP_USER || '';
  const password = config?.password || process.env.SMTP_PASSWORD || process.env.SMTP_PASS || '';
  const fromEmail = config?.fromEmail || process.env.SMTP_FROM_EMAIL || process.env.SMTP_FROM || username || 'info@sync2dine.io';
  const fromName = config?.fromName || process.env.SMTP_FROM_NAME || 'Sync2Dine';
  return { host, port, username, password, fromEmail, fromName };
}

export async function sendViaSmtp(payload: SendPayload, to: string): Promise<{ success: boolean; error?: string; messageId?: string }> {
  const smtp = resolveSmtp(payload.config);
  if (!smtp.host || !smtp.username || !smtp.password) {
    return { success: false, error: 'SMTP not configured (host, username, password required).' };
  }

  // The sender (e.g. a non-English-speaking worker) may have composed this in their own
  // language — never let untranslated free text reach a customer's inbox.
  const guard = await ensureEnglishForCustomerSend(payload.body ?? '', payload.sourceLang, getRequestOrgId());
  if (!guard.ok) {
    return { success: false, error: 'Could not translate the message to English before sending — email was not sent.' };
  }

  let nodemailer: typeof import('nodemailer');
  try {
    nodemailer = await import('nodemailer');
  } catch {
    return { success: false, error: 'nodemailer not installed on server.' };
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.username, pass: smtp.password },
  });

  const attachments = payload.attachment
    ? [{
        filename: payload.attachment.filename,
        content: Buffer.from(payload.attachment.content, 'base64'),
        contentType: payload.attachment.mimeType,
      }]
    : undefined;

  let html = payload.html;
  if (html?.trim()) {
    const htmlGuard = await ensureEnglishForCustomerSend(html, payload.sourceLang, getRequestOrgId());
    if (!htmlGuard.ok) {
      return { success: false, error: 'Could not translate the HTML email to English before sending.' };
    }
    html = htmlGuard.english;
  } else {
    try {
      const { wrapSalesEmail } = await import('./sales-email-html');
      html = wrapSalesEmail(guard.english, {
        subject: payload.subject,
        heroTitle: payload.subject,
        companyName: smtp.fromName || 'Sync2Dine',
      }).html;
    } catch {
      /* plain text only fallback */
    }
  }

  const info = await transporter.sendMail({
    from: `"${smtp.fromName}" <${smtp.fromEmail}>`,
    to,
    subject: payload.subject ?? '',
    text: guard.english,
    html,
    attachments,
  });

  return { success: true, messageId: info.messageId };
}

async function sendViaResend(payload: SendPayload, to: string): Promise<{ success: boolean; error?: string; messageId?: string }> {
  const apiKey = payload.config?.apiKey?.trim()
    || process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return { success: false, error: 'Resend API key not configured.' };
  }

  // The sender (e.g. a non-English-speaking worker) may have composed this in their own
  // language — never let untranslated free text reach a customer's inbox.
  const guard = await ensureEnglishForCustomerSend(payload.body ?? '', payload.sourceLang, getRequestOrgId());
  if (!guard.ok) {
    return { success: false, error: 'Could not translate the message to English before sending — email was not sent.' };
  }

  const fromEmail = payload.config?.fromEmail?.trim()
    || process.env.RESEND_FROM_EMAIL?.trim()
    || process.env.SMTP_FROM_EMAIL?.trim()
    || 'onboarding@resend.dev';
  const fromName = payload.config?.fromName?.trim() || process.env.SMTP_FROM_NAME?.trim() || 'Sync2Dine';

  let html = payload.html;
  if (!html?.trim()) {
    try {
      const { wrapSalesEmail } = await import('./sales-email-html');
      html = wrapSalesEmail(guard.english, {
        subject: payload.subject,
        heroTitle: payload.subject,
        companyName: fromName,
      }).html;
    } catch {
      html = undefined;
    }
  }

  const body: Record<string, unknown> = {
    from: `${fromName} <${fromEmail}>`,
    to: [to],
    subject: payload.subject ?? '',
    text: guard.english,
    ...(html ? { html } : {}),
  };

  if (payload.attachment) {
    body.attachments = [{
      filename: payload.attachment.filename,
      content: payload.attachment.content,
    }];
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as { id?: string; message?: string };
  if (!res.ok) {
    return { success: false, error: data.message || `Resend error (${res.status})` };
  }
  return { success: true, messageId: data.id };
}

export async function handleMessageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname === '/api/messages/schedule') {
    if (req.method === 'GET') {
      const { listScheduledMessages } = await import('./scheduled-messages-store');
      const orgId = String(req.headers['x-org-id'] || getRequestOrgId() || '');
      sendJson(res, 200, { jobs: listScheduledMessages(orgId || undefined) });
      return true;
    }
    if (req.method === 'DELETE') {
      let body: { id?: string };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return true;
      }
      const { cancelScheduledMessage } = await import('./scheduled-messages-store');
      const job = cancelScheduledMessage(String(body.id || ''));
      sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { error: 'not_found' });
      return true;
    }
    if (req.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return true;
      }
      const sendAt = String(body.sendAt || '');
      if (!sendAt || !Number.isFinite(Date.parse(sendAt))) {
        sendJson(res, 400, { error: 'sendAt ISO datetime required' });
        return true;
      }
      const channelsRaw = body.channels;
      const channels: Array<'email' | 'whatsapp'> = Array.isArray(channelsRaw)
        ? channelsRaw.filter((c): c is 'email' | 'whatsapp' => c === 'email' || c === 'whatsapp')
        : ['email'];
      const { enqueueScheduledMessage } = await import('./scheduled-messages-store');
      const job = enqueueScheduledMessage({
        orgId: String(body.orgId || req.headers['x-org-id'] || getRequestOrgId() || ''),
        sendAt: new Date(sendAt).toISOString(),
        channels: channels.length ? channels : ['email'],
        toEmail: body.toEmail ? String(body.toEmail) : undefined,
        toPhone: body.toPhone ? String(body.toPhone) : undefined,
        customerId: body.customerId ? String(body.customerId) : undefined,
        customerName: body.customerName ? String(body.customerName) : undefined,
        templateId: body.templateId ? String(body.templateId) : undefined,
        subject: String(body.subject || ''),
        body: String(body.body || ''),
        createdBy: String(body.createdBy || 'hub'),
        aim: body.aim ? String(body.aim) : 'followup',
        heroTitle: body.heroTitle ? String(body.heroTitle) : undefined,
        ctaUrl: body.ctaUrl ? String(body.ctaUrl) : undefined,
        ctaLabel: body.ctaLabel ? String(body.ctaLabel) : undefined,
      });
      sendJson(res, 200, { ok: true, job });
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  if (pathname === '/api/messages/templates') {
    const { SALES_TEMPLATES } = await import('./sales-templates');
    sendJson(res, 200, { templates: SALES_TEMPLATES });
    return true;
  }

  if (pathname !== '/api/messages/send' && pathname !== '/api/messages/test') return false;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  let payload: SendPayload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return true;
  }

  if (pathname === '/api/messages/test') {
    const to = payload.to || resolveSmtp(payload.config).fromEmail;
    if (!to) {
      sendJson(res, 400, { error: 'No recipient for test email.' });
      return true;
    }
    try {
      const provider = payload.provider || 'email_smtp';
      const result = provider === 'resend'
        ? await sendViaResend({
          ...payload,
          to,
          subject: payload.subject || 'Sync2Dine email test',
          body: payload.body || 'This is a test email confirming your Resend settings work.',
        }, to)
        : await sendViaSmtp({
          ...payload,
          to,
          subject: payload.subject || 'Sync2Dine SMTP test',
          body: payload.body || 'This is a test email confirming your SMTP settings work.',
        }, to);
      sendJson(res, result.success ? 200 : 500, result);
    } catch (err) {
      sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Send failed' });
    }
    return true;
  }

  const to = payload.to;
  if (!to) {
    sendJson(res, 400, { success: false, error: 'No recipient address.' });
    return true;
  }

  const provider = payload.provider || 'email_smtp';

  try {
    const result = provider === 'resend'
      ? await sendViaResend(payload, to)
      : provider === 'email_smtp'
        ? await sendViaSmtp(payload, to)
        : { success: false, error: `Provider ${provider} not supported — use email_smtp or resend.` };
    sendJson(res, result.success ? 200 : 500, result);
  } catch (err) {
    sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Send failed' });
  }
  return true;
}
