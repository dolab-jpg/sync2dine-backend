/**
 * Ops alert email via connected Gmail OAuth mailbox (same tokens as Communications Hub).
 * Falls back to SMTP_HOST credentials when no Google mailbox is connected.
 */
import { getConnection, listActiveConnections } from './mailbox/mailbox-store';
import { getValidAccessToken } from './mailbox/tokenService';
import { getProvider } from './mailbox/providers';
import type { MailboxConnection } from './mailbox/types';
import { sendPlainTextEmail } from './email-service';

export type OpsEmailResult = {
  ok: boolean;
  error?: string;
  messageId?: string;
  via?: 'gmail_oauth' | 'smtp';
  from?: string;
};

function resolveOpsGmailConnection(): MailboxConnection | null {
  const preferredId = process.env.OPS_GMAIL_CONNECTION_ID?.trim();
  if (preferredId) {
    const byId = getConnection(preferredId);
    if (byId && byId.status === 'connected' && byId.provider === 'google') return byId;
  }

  const preferredEmail = (
    process.env.OPS_GMAIL_FROM?.trim()
    || process.env.SMTP_FROM_EMAIL?.trim()
    || ''
  ).toLowerCase();

  const google = listActiveConnections().filter((c) => c.provider === 'google');
  if (preferredEmail) {
    const match = google.find((c) => c.emailAddress.toLowerCase() === preferredEmail);
    if (match) return match;
  }
  return google[0] ?? null;
}

async function sendViaGmailOAuth(opts: {
  to: string;
  subject: string;
  text: string;
  conn: MailboxConnection;
}): Promise<OpsEmailResult> {
  let nodemailer: typeof import('nodemailer');
  try {
    nodemailer = await import('nodemailer');
  } catch {
    return { ok: false, error: 'nodemailer_unavailable', via: 'gmail_oauth' };
  }

  const provider = getProvider(opts.conn.provider);
  const { smtp } = provider.getConfig();
  const accessToken = await getValidAccessToken(opts.conn.id);
  const fromAddr = opts.conn.emailAddress;
  const fromName = opts.conn.displayName || 'Sync2Dine Ops';

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      type: 'OAuth2',
      user: fromAddr,
      accessToken,
      getAccessToken: () => getValidAccessToken(opts.conn.id),
    },
  } as import('nodemailer').TransportOptions);

  const info = await transporter.sendMail({
    from: `"${fromName}" <${fromAddr}>`,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  });

  return {
    ok: true,
    messageId: info.messageId,
    via: 'gmail_oauth',
    from: fromAddr,
  };
}

/** Prefer connected Gmail OAuth; fall back to classic SMTP env. */
export async function sendOpsAlertEmail(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<OpsEmailResult> {
  const to = opts.to.trim();
  if (!to) return { ok: false, error: 'no_recipient' };

  const conn = resolveOpsGmailConnection();
  if (conn) {
    try {
      return await sendViaGmailOAuth({ ...opts, to, conn });
    } catch (err) {
      console.error(
        '[ops-gmail-send] gmail_oauth failed, trying SMTP:',
        err instanceof Error ? err.message : err,
      );
      const smtp = await sendPlainTextEmail(opts);
      if (smtp.ok) {
        return { ok: true, messageId: smtp.messageId, via: 'smtp' };
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'gmail_oauth_failed',
        via: 'gmail_oauth',
        from: conn.emailAddress,
      };
    }
  }

  const smtp = await sendPlainTextEmail(opts);
  if (smtp.ok) {
    return { ok: true, messageId: smtp.messageId, via: 'smtp' };
  }
  return {
    ok: false,
    error: smtp.error || 'no_gmail_mailbox_and_smtp_not_configured',
    via: 'smtp',
  };
}

export function getOpsGmailSenderHint(): string | null {
  return resolveOpsGmailConnection()?.emailAddress ?? null;
}
