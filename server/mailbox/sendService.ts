import { randomUUID } from 'crypto';
import type { SendMailboxPayload } from './types';
import { getConnection } from './mailbox-store';
import { getProvider } from './providers';
import { getValidAccessToken } from './tokenService';
import { ensureEnglishForCustomerSend } from '../outbound-english-guard';
import { getRequestOrgId } from '../data-store';

async function englishMailboxPayload(
  payload: SendMailboxPayload,
): Promise<{ ok: true; payload: SendMailboxPayload } | { ok: false; error: string }> {
  const orgId = getRequestOrgId();
  const bodyGuard = await ensureEnglishForCustomerSend(payload.body ?? '', null, orgId);
  if (!bodyGuard.ok) {
    return { ok: false, error: 'Could not translate the email body to English before sending.' };
  }
  let html = payload.html;
  if (html?.trim()) {
    const htmlGuard = await ensureEnglishForCustomerSend(html, null, orgId);
    if (!htmlGuard.ok) {
      return { ok: false, error: 'Could not translate the email HTML to English before sending.' };
    }
    html = htmlGuard.english;
  }
  const subjectGuard = await ensureEnglishForCustomerSend(payload.subject ?? '', null, orgId);
  if (!subjectGuard.ok) {
    return { ok: false, error: 'Could not translate the email subject to English before sending.' };
  }
  return {
    ok: true,
    payload: { ...payload, body: bodyGuard.english, html, subject: subjectGuard.english },
  };
}

export async function sendFromMailbox(payload: SendMailboxPayload): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const conn = getConnection(payload.connectionId);
  if (!conn) return { success: false, error: 'Connection not found' };
  if (conn.status === 'needs_reconnect' || conn.status === 'disconnected') {
    return { success: false, error: 'Mailbox needs reconnect before sending' };
  }

  const guarded = await englishMailboxPayload(payload);
  if (!guarded.ok) return { success: false, error: guarded.error };
  const safe = guarded.payload;

  let nodemailer: typeof import('nodemailer');
  try {
    nodemailer = await import('nodemailer');
  } catch {
    return { success: false, error: 'nodemailer not available' };
  }

  const provider = getProvider(conn.provider);
  const { smtp } = provider.getConfig();
  const accessToken = await getValidAccessToken(payload.connectionId);

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      type: 'OAuth2',
      user: conn.emailAddress,
      accessToken,
      getAccessToken: () => getValidAccessToken(payload.connectionId),
    },
  } as import('nodemailer').TransportOptions);

  const attachments = safe.attachments?.map(a => ({
    filename: a.filename,
    content: Buffer.from(a.content, 'base64'),
    contentType: a.mimeType,
  }));

  const info = await transporter.sendMail({
    from: `"${conn.displayName || conn.emailAddress}" <${conn.emailAddress}>`,
    to: safe.to,
    cc: safe.cc,
    subject: safe.subject,
    text: safe.body,
    html: safe.html,
    attachments,
  });

  return { success: true, messageId: info.messageId };
}

export async function sendMockEmail(payload: SendMailboxPayload): Promise<{ success: boolean; messageId: string; error?: string }> {
  const guarded = await englishMailboxPayload(payload);
  if (!guarded.ok) return { success: false, messageId: '', error: guarded.error };
  return { success: true, messageId: `<mock-${randomUUID()}@tradepro.local>` };
}
