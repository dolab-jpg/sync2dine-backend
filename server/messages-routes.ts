import type { IncomingMessage, ServerResponse } from 'http';

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
  attachment?: { filename: string; mimeType: string; content: string };
  config?: SmtpConfig;
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
  const fromEmail = config?.fromEmail || process.env.SMTP_FROM_EMAIL || process.env.SMTP_FROM || username;
  const fromName = config?.fromName || process.env.SMTP_FROM_NAME || 'TradePro';
  return { host, port, username, password, fromEmail, fromName };
}

export async function sendViaSmtp(payload: SendPayload, to: string): Promise<{ success: boolean; error?: string; messageId?: string }> {
  const smtp = resolveSmtp(payload.config);
  if (!smtp.host || !smtp.username || !smtp.password) {
    return { success: false, error: 'SMTP not configured (host, username, password required).' };
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

  const info = await transporter.sendMail({
    from: `"${smtp.fromName}" <${smtp.fromEmail}>`,
    to,
    subject: payload.subject ?? '',
    text: payload.body ?? '',
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

  const fromEmail = payload.config?.fromEmail?.trim()
    || process.env.RESEND_FROM_EMAIL?.trim()
    || process.env.SMTP_FROM_EMAIL?.trim()
    || 'onboarding@resend.dev';
  const fromName = payload.config?.fromName?.trim() || process.env.SMTP_FROM_NAME?.trim() || 'TradePro';

  const body: Record<string, unknown> = {
    from: `${fromName} <${fromEmail}>`,
    to: [to],
    subject: payload.subject ?? '',
    text: payload.body ?? '',
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
          subject: payload.subject || 'TradePro email test',
          body: payload.body || 'This is a test email confirming your Resend settings work.',
        }, to)
        : await sendViaSmtp({
          ...payload,
          to,
          subject: payload.subject || 'TradePro SMTP test',
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
