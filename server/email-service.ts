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

export async function sendOrgInviteEmail(org: Organization): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    console.log(`[email] Invite skipped (no SMTP) for ${org.contactEmail}`);
    return;
  }
  const baseUrl = process.env.APP_BASE_URL?.trim() || 'http://localhost:5174';
  const from = process.env.SMTP_FROM?.trim()
    || process.env.SMTP_FROM_EMAIL?.trim()
    || resolveSmtpUser();
  await transport.sendMail({
    from,
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
}
