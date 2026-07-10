import nodemailer from 'nodemailer';
import type { Organization } from './organizations';

function getTransport() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
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
  await transport.sendMail({
    from: process.env.SMTP_FROM?.trim() || process.env.SMTP_USER,
    to: org.contactEmail,
    subject: `Welcome to TradePro — ${org.name}`,
    text: [
      `Hi ${org.contactName},`,
      '',
      `Your TradePro workspace "${org.name}" has been provisioned.`,
      '',
      `Sign in at: ${baseUrl}`,
      '',
      'Your administrator will share login credentials separately.',
      '',
      '— TradePro Platform',
    ].join('\n'),
  });
}
