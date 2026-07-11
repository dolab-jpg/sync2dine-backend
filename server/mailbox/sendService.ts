import { randomUUID } from 'crypto';
import type { SendMailboxPayload } from './types';
import { getConnection } from './mailbox-store';
import { getProvider } from './providers';
import { getValidAccessToken } from './tokenService';

export async function sendFromMailbox(payload: SendMailboxPayload): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const conn = getConnection(payload.connectionId);
  if (!conn) return { success: false, error: 'Connection not found' };
  if (conn.status !== 'connected') {
    return { success: false, error: 'Mailbox needs reconnect before sending' };
  }

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

  const attachments = payload.attachments?.map(a => ({
    filename: a.filename,
    content: Buffer.from(a.content, 'base64'),
    contentType: a.mimeType,
  }));

  const info = await transporter.sendMail({
    from: `"${conn.displayName || conn.emailAddress}" <${conn.emailAddress}>`,
    to: payload.to,
    cc: payload.cc,
    subject: payload.subject,
    text: payload.body,
    html: payload.html,
    attachments,
  });

  return { success: true, messageId: info.messageId };
}

export async function sendMockEmail(payload: SendMailboxPayload): Promise<{ success: boolean; messageId: string }> {
  return { success: true, messageId: `<mock-${randomUUID()}@tradepro.local>` };
}
