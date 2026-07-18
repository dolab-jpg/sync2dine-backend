import { dueScheduledMessages, updateScheduledMessage } from './scheduled-messages-store';
import { wrapSalesEmail } from './sales-email-html';
import { sendPlainTextEmail } from './email-service';

const POLL_MS = Number(process.env.SCHEDULED_MESSAGE_POLL_MS ?? 45000);

export function startScheduledMessageWorker(): void {
  if (process.env.DISABLE_SCHEDULED_MESSAGE_WORKER === '1') return;
  setInterval(() => {
    void processDueScheduledMessages().catch((err) => {
      console.error('[scheduled-messages] worker error:', err);
    });
  }, POLL_MS);
  console.log(`[scheduled-messages] worker started (poll ${POLL_MS}ms)`);
}

async function sendWhatsAppIfConfigured(to: string, message: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { isMetaWhatsAppEnabled, sendWhatsAppText } = await import('./whatsapp-webhook');
    const waToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
    const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    if (!isMetaWhatsAppEnabled() || !waToken || !waPhoneId) {
      return { ok: false, error: 'whatsapp_not_configured' };
    }
    const phone = to.startsWith('+') ? to : `+${to}`;
    await sendWhatsAppText(waPhoneId, waToken, phone, message);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'whatsapp_failed' };
  }
}

export async function processDueScheduledMessages(): Promise<number> {
  const due = dueScheduledMessages();
  let sent = 0;
  for (const job of due) {
    const errors: string[] = [];
    let anyOk = false;

    if (job.channels.includes('email') && job.toEmail) {
      const wrapped = wrapSalesEmail(job.body, {
        subject: job.subject,
        heroTitle: job.heroTitle || job.subject,
        ctaUrl: job.ctaUrl,
        ctaLabel: job.ctaLabel,
        companyName: 'Sync2Dine',
        sentBy: 'Sally · Sync2Dine',
      });
      const r = await sendPlainTextEmail({
        to: job.toEmail,
        subject: job.subject,
        text: wrapped.text,
        html: wrapped.html,
      });
      if (r.ok) anyOk = true;
      else errors.push(r.error);
    }

    if (job.channels.includes('whatsapp') && job.toPhone) {
      const r = await sendWhatsAppIfConfigured(job.toPhone, job.body);
      if (r.ok) anyOk = true;
      else errors.push(r.error || 'whatsapp_failed');
    }

    if (anyOk) {
      updateScheduledMessage(job.id, {
        status: 'sent',
        sentAt: new Date().toISOString(),
        error: errors.length ? errors.join('; ') : undefined,
      });
      sent += 1;
      if (job.customerId) {
        try {
          const { appendCustomerCallActivity } = await import('./data-store');
          appendCustomerCallActivity({
            customerId: job.customerId,
            summary: `Scheduled message sent (${job.channels.join('+')}): ${job.subject}`,
            detail: job.body.slice(0, 400),
            aim: job.aim || 'followup',
            type: 'note',
            createdBy: job.createdBy || 'scheduler',
          });
        } catch {
          /* non-fatal */
        }
      }
    } else {
      updateScheduledMessage(job.id, {
        status: 'failed',
        error: errors.join('; ') || 'send_failed',
      });
    }
  }
  return sent;
}
