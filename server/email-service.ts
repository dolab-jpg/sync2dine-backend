import nodemailer from 'nodemailer';
import type { Organization } from './organizations';

function resolveSmtpUser(): string | undefined {
  return process.env.SMTP_USERNAME?.trim()
    || process.env.SMTP_USER?.trim();
}

function resolveSmtpPass(): string | undefined {
  return process.env.SMTP_PASSWORD?.trim()
    || process.env.SMTP_PASS?.trim();
}

function getTransport() {
  const host = process.env.SMTP_HOST?.trim();
  const user = resolveSmtpUser();
  const pass = resolveSmtpPass();
  if (!host || !user) return null;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
}

export async function sendPlainTextEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  const transport = getTransport();
  if (!transport) {
    return { ok: false, error: 'smtp_not_configured' };
  }
  const from = process.env.SMTP_FROM?.trim()
    || process.env.SMTP_FROM_EMAIL?.trim()
    || resolveSmtpUser();
  if (!from) {
    return { ok: false, error: 'smtp_from_missing' };
  }
  const fromName = process.env.SMTP_FROM_NAME?.trim() || 'Sync2Dine';
  try {
    const info = await transport.sendMail({
      from: `"${fromName}" <${from}>`,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'smtp_send_failed' };
  }
}

export async function sendOrgInviteEmail(org: Organization): Promise<void> {
  const baseUrl = process.env.APP_BASE_URL?.trim() || 'http://localhost:5174';
  const result = await sendPlainTextEmail({
    to: org.contactEmail,
    subject: `Welcome to Sync2Dine — ${org.name}`,
    text: [
      `Hi ${org.contactName},`,
      '',
      `Your Sync2Dine workspace "${org.name}" has been provisioned.`,
      '',
      `Sign in at: ${baseUrl}`,
      '',
      'Your administrator will share login credentials separately.',
      '',
      '— Sync2Dine',
    ].join('\n'),
  });
  if (!result.ok) {
    console.log(`[email] Invite skipped (${result.error}) for ${org.contactEmail}`);
  }
}
