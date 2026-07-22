/**
 * Customer-facing weekly usage invoice content + branded PDF/email.
 * Sell lines only — never include cost/margin fields.
 */
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import type { WeeklyBillingBreakdown } from './weekly-usage-billing';
import { toCustomerBreakdown } from './weekly-usage-billing';

const A4: [number, number] = [595.28, 841.89];
const C = {
  teal: rgb(15 / 255, 61 / 255, 62 / 255),
  tealDeep: rgb(16 / 255, 47 / 255, 48 / 255),
  tealSoft: rgb(22 / 255, 73 / 255, 74 / 255),
  cream: rgb(246 / 255, 239 / 255, 224 / 255),
  creamBright: rgb(1, 248 / 255, 223 / 255),
  gold: rgb(232 / 255, 194 / 255, 106 / 255),
  goldSoft: rgb(243 / 255, 221 / 255, 164 / 255),
  ink: rgb(11 / 255, 34 / 255, 35 / 255),
  muted: rgb(83 / 255, 101 / 255, 99 / 255),
  white: rgb(1, 1, 1),
  line: rgb(234 / 255, 220 / 255, 185 / 255),
};

export const SYNC2DINE_INVOICE_CONTACT = {
  website: 'sync2dine.io',
  phone: '020 3745 3233',
  phoneTel: '+442037453233',
  email: 'info@sync2dine.io',
} as const;

export type SaasUsageInvoiceContent = {
  brand: {
    name: 'Sync2Dine';
    contact: typeof SYNC2DINE_INVOICE_CONTACT;
  };
  invoice: {
    reference: string;
    status: 'paid' | 'due' | 'open';
    issuedDate: string;
    periodLabel: string;
    isoWeek: string;
    hostedInvoiceUrl?: string;
  };
  customer: {
    name: string;
    email?: string;
    address?: string;
  };
  plan: {
    packageName: string;
  };
  usageSummary: Array<{ label: string; included: number; used: number; unit: string }>;
  lines: Array<{
    description: string;
    quantity: number;
    unitPriceGbp: number;
    amountGbp: number;
  }>;
  amountGbp: number;
  paymentNote: string;
};

export type SaasUsageInvoiceEmail = {
  subject: string;
  html: string;
  text: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function money(value: number): string {
  return `£${value.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function safeText(value: string): string {
  return value
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\u00a0/g, ' ');
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { timeZone: 'UTC' });
}

/** Build customer invoice content from a rated week. Rejects internal margin keys. */
export function buildSaasUsageInvoiceContent(input: {
  breakdown: WeeklyBillingBreakdown | ReturnType<typeof toCustomerBreakdown>;
  customerName: string;
  customerEmail?: string;
  customerAddress?: string;
  stripeInvoiceId?: string;
  hostedInvoiceUrl?: string;
  status?: 'paid' | 'due' | 'open';
}): SaasUsageInvoiceContent {
  const raw = input.breakdown as WeeklyBillingBreakdown;
  const withMargins: WeeklyBillingBreakdown = 'internalMargins' in raw && raw.internalMargins
    ? raw
    : {
        ...(raw as Omit<WeeklyBillingBreakdown, 'internalMargins'>),
        internalMargins: {
          lines: [],
          totalSellGbp: 0,
          totalCostGbp: 0,
          totalMarginGbp: 0,
          totalMarginPct: 0,
          providerCostUsd: 0,
        },
      };
  const customer = toCustomerBreakdown(withMargins);

  const status = input.status
    ?? (input.hostedInvoiceUrl && customer.customerSubtotalGbp > 0 ? 'due' : 'open');
  const paymentNote = status === 'paid'
    ? 'This amount was charged to the card on file for your Sync2Dine subscription.'
    : input.hostedInvoiceUrl
      ? 'We could not debit your card automatically. Please complete payment using the secure Stripe invoice link.'
      : 'This amount will be charged to the card on file for your Sync2Dine subscription.';

  return {
    brand: { name: 'Sync2Dine', contact: SYNC2DINE_INVOICE_CONTACT },
    invoice: {
      reference: input.stripeInvoiceId || `USAGE-${customer.isoWeek}-${customer.orgId.slice(0, 8)}`,
      status,
      issuedDate: formatDate(new Date().toISOString()),
      periodLabel: customer.weekLabel,
      isoWeek: customer.isoWeek,
      hostedInvoiceUrl: input.hostedInvoiceUrl,
    },
    customer: {
      name: input.customerName,
      email: input.customerEmail,
      address: input.customerAddress,
    },
    plan: { packageName: customer.packageName },
    usageSummary: customer.usageSummary.map((row) => ({
      label: row.label,
      included: row.included,
      used: row.used,
      unit: row.unit,
    })),
    lines: customer.customerLines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceGbp: line.unitPriceGbp,
      amountGbp: line.amountGbp,
    })),
    amountGbp: customer.customerSubtotalGbp,
    paymentNote,
  };
}

export function buildSaasUsageInvoiceEmail(content: SaasUsageInvoiceContent): SaasUsageInvoiceEmail {
  const { contact } = content.brand;
  const subject = `Usage invoice — ${content.invoice.periodLabel} | Sync2Dine`;
  const statusLabel = content.invoice.status === 'paid' ? 'PAID' : 'AMOUNT DUE';
  const cta = content.invoice.status !== 'paid' && content.invoice.hostedInvoiceUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;"><tr><td bgcolor="#e8c26a" style="border-radius:6px;"><a href="${escapeHtml(content.invoice.hostedInvoiceUrl)}" style="display:inline-block;padding:15px 25px;color:#102f30;text-decoration:none;font:700 14px Arial,sans-serif;letter-spacing:.04em;">Pay invoice securely</a></td></tr></table>`
    : '';

  const lineRows = content.lines.length
    ? content.lines.map((line) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #eadcb9;color:#263b3a;font:13px/1.45 Arial,sans-serif;">${escapeHtml(line.description)}</td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid #eadcb9;color:#0f3d3e;font:700 13px Arial,sans-serif;white-space:nowrap;">${money(line.amountGbp)}</td>
      </tr>`).join('')
    : `<tr><td colspan="2" style="padding:10px 0;color:#536563;font:13px Arial,sans-serif;">No overage charges this week.</td></tr>`;

  const usageRows = content.usageSummary.map((row) => `
    <tr>
      <td style="padding:6px 0;color:#536563;font:13px Arial,sans-serif;">${escapeHtml(row.label)}</td>
      <td align="right" style="padding:6px 0;color:#0f3d3e;font:13px Arial,sans-serif;">${row.used} / ${row.included} ${escapeHtml(row.unit)}</td>
    </tr>`).join('');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6efe0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6efe0;">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;background:#ffffff;border:1px solid #eadcb9;">
        <tr><td style="padding:24px 30px;background:#102f30;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="color:#fff8df;font:700 22px Arial,sans-serif;">Sync<span style="color:#e8c26a;">2</span>Dine</td>
            <td align="right" style="color:#f3dda4;font:11px Arial,sans-serif;">INVOICE ${escapeHtml(content.invoice.reference)}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:34px 30px 20px;">
          <p style="margin:0 0 10px;color:#16494a;font:700 11px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;">Bill to ${escapeHtml(content.customer.name)}</p>
          <h1 style="margin:0;color:#0f3d3e;font:700 28px/1.15 Arial,sans-serif;">Weekly usage invoice</h1>
          <p style="margin:12px 0 0;color:#536563;font:15px/1.55 Arial,sans-serif;">${escapeHtml(content.plan.packageName)} · ${escapeHtml(content.invoice.periodLabel)}</p>
        </td></tr>
        <tr><td style="padding:0 30px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0f3d3e;">
            <tr>
              <td style="padding:22px 24px;">
                <div style="color:#f3dda4;font:700 10px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;">${statusLabel}</div>
                <div style="margin-top:7px;color:#ffffff;font:700 32px Arial,sans-serif;">${money(content.amountGbp)}</div>
              </td>
              <td align="right" valign="middle" style="padding:22px 24px;color:#f6efe0;font:13px/1.5 Arial,sans-serif;">Issued<br><strong style="color:#e8c26a;">${escapeHtml(content.invoice.issuedDate)}</strong></td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:28px 30px 8px;">
          <h2 style="margin:0 0 12px;color:#102f30;font:700 16px Arial,sans-serif;">Usage this week</h2>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${usageRows}</table>
        </td></tr>
        <tr><td style="padding:16px 30px 8px;">
          <h2 style="margin:0 0 12px;color:#102f30;font:700 16px Arial,sans-serif;">Charges</h2>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${lineRows}</table>
          <p style="margin:18px 0 0;color:#536563;font:13px/1.55 Arial,sans-serif;">${escapeHtml(content.paymentNote)}</p>
          ${cta}
        </td></tr>
        <tr><td style="padding:22px 30px;background:#fff8df;border-top:1px solid #eadcb9;">
          <p style="margin:0;color:#0f3d3e;font:700 14px Arial,sans-serif;">Sync2Dine billing</p>
          <p style="margin:7px 0 0;color:#667775;font:12px/1.6 Arial,sans-serif;">
            <a href="https://${escapeHtml(contact.website)}" style="color:#16494a;text-decoration:none;">${escapeHtml(contact.website)}</a> ·
            <a href="tel:${escapeHtml(contact.phoneTel)}" style="color:#16494a;text-decoration:none;">${escapeHtml(contact.phone)}</a> ·
            <a href="mailto:${escapeHtml(contact.email)}" style="color:#16494a;text-decoration:none;">${escapeHtml(contact.email)}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Sync2Dine — Weekly usage invoice`,
    `Bill to: ${content.customer.name}`,
    `Reference: ${content.invoice.reference}`,
    `Period: ${content.invoice.periodLabel}`,
    `Plan: ${content.plan.packageName}`,
    '',
    `Amount ${content.invoice.status === 'paid' ? 'paid' : 'due'}: ${money(content.amountGbp)}`,
    '',
    'Usage this week:',
    ...content.usageSummary.map((r) => `- ${r.label}: ${r.used} / ${r.included} ${r.unit}`),
    '',
    'Charges:',
    ...(content.lines.length
      ? content.lines.map((l) => `- ${l.description}: ${money(l.amountGbp)}`)
      : ['- No overage charges this week.']),
    '',
    content.paymentNote,
    ...(content.invoice.hostedInvoiceUrl && content.invoice.status !== 'paid'
      ? ['', `Pay securely: ${content.invoice.hostedInvoiceUrl}`]
      : []),
    '',
    `Sync2Dine · ${contact.website} · ${contact.phone} · ${contact.email}`,
  ].join('\n');

  return { subject, html, text };
}

type Fonts = { regular: PDFFont; bold: PDFFont };

function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = safeText(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function generateSaasUsageInvoicePdf(
  content: SaasUsageInvoiceContent,
): Promise<{ filename: string; mimeType: 'application/pdf'; bytes: Uint8Array }> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const page = doc.addPage(A4);
  const [width, height] = A4;

  page.drawRectangle({ x: 0, y: 0, width, height, color: C.cream });
  page.drawRectangle({ x: 0, y: height - 72, width, height: 72, color: C.tealDeep });
  page.drawText('Sync2Dine', {
    x: 44,
    y: height - 44,
    font: fonts.bold,
    size: 20,
    color: C.creamBright,
  });
  page.drawText(`INVOICE  ${safeText(content.invoice.reference)}`, {
    x: width - 260,
    y: height - 42,
    font: fonts.bold,
    size: 10,
    color: C.goldSoft,
  });

  let y = height - 110;
  page.drawText('WEEKLY USAGE INVOICE', {
    x: 44,
    y,
    font: fonts.bold,
    size: 9,
    color: C.tealSoft,
  });
  y -= 22;
  page.drawText(safeText(content.plan.packageName), {
    x: 44,
    y,
    font: fonts.bold,
    size: 22,
    color: C.teal,
  });
  y -= 18;
  page.drawText(safeText(`Bill to: ${content.customer.name}`), {
    x: 44,
    y,
    font: fonts.regular,
    size: 11,
    color: C.ink,
  });
  y -= 14;
  page.drawText(safeText(`Period: ${content.invoice.periodLabel}`), {
    x: 44,
    y,
    font: fonts.regular,
    size: 10,
    color: C.muted,
  });

  y -= 28;
  page.drawRectangle({ x: 44, y: y - 8, width: width - 88, height: 54, color: C.teal });
  page.drawText(content.invoice.status === 'paid' ? 'PAID' : 'AMOUNT DUE', {
    x: 60,
    y: y + 28,
    font: fonts.bold,
    size: 9,
    color: C.goldSoft,
  });
  page.drawText(money(content.amountGbp), {
    x: 60,
    y: y + 6,
    font: fonts.bold,
    size: 24,
    color: C.white,
  });
  page.drawText(`Issued ${safeText(content.invoice.issuedDate)}`, {
    x: width - 200,
    y: y + 18,
    font: fonts.regular,
    size: 10,
    color: C.cream,
  });

  y -= 40;
  page.drawText('Usage this week', {
    x: 44,
    y,
    font: fonts.bold,
    size: 13,
    color: C.tealDeep,
  });
  y -= 18;
  for (const row of content.usageSummary) {
    page.drawText(safeText(row.label), { x: 44, y, font: fonts.regular, size: 10, color: C.ink });
    page.drawText(`${row.used} / ${row.included} ${row.unit}`, {
      x: width - 180,
      y,
      font: fonts.bold,
      size: 10,
      color: C.teal,
    });
    y -= 16;
  }

  y -= 12;
  page.drawText('Charges', {
    x: 44,
    y,
    font: fonts.bold,
    size: 13,
    color: C.tealDeep,
  });
  y -= 8;
  page.drawLine({ start: { x: 44, y }, end: { x: width - 44, y }, thickness: 0.8, color: C.gold });
  y -= 18;

  if (!content.lines.length) {
    page.drawText('No overage charges this week.', {
      x: 44,
      y,
      font: fonts.regular,
      size: 10,
      color: C.muted,
    });
    y -= 16;
  } else {
    for (const line of content.lines) {
      const descLines = wrapText(line.description, fonts.regular, 9.5, width - 180);
      for (let i = 0; i < descLines.length; i += 1) {
        page.drawText(descLines[i]!, {
          x: 44,
          y,
          font: fonts.regular,
          size: 9.5,
          color: C.ink,
        });
        if (i === 0) {
          page.drawText(money(line.amountGbp), {
            x: width - 110,
            y,
            font: fonts.bold,
            size: 10,
            color: C.teal,
          });
        }
        y -= 13;
      }
      y -= 6;
      if (y < 120) break;
    }
  }

  y -= 10;
  const noteLines = wrapText(content.paymentNote, fonts.regular, 9.5, width - 88);
  for (const line of noteLines) {
    page.drawText(line, { x: 44, y, font: fonts.regular, size: 9.5, color: C.muted });
    y -= 13;
  }

  page.drawLine({
    start: { x: 44, y: 46 },
    end: { x: width - 44, y: 46 },
    thickness: 0.6,
    color: C.gold,
  });
  const { contact } = content.brand;
  page.drawText(`${contact.website}  |  ${contact.phone}  |  ${contact.email}`, {
    x: 44,
    y: 28,
    font: fonts.regular,
    size: 8.2,
    color: C.muted,
  });

  const bytes = await doc.save();
  return {
    filename: `Sync2Dine-usage-invoice-${content.invoice.isoWeek}.pdf`,
    mimeType: 'application/pdf',
    bytes,
  };
}

/** Guard for tests / delivery — customer artifacts must not mention internal cost/margin fields. */
export function customerArtifactContainsInternalLeak(text: string): boolean {
  // Do not match CSS `margin:` — only internal billing vocabulary.
  return /\b(marginGbp|marginPct|totalMargin|costGbp|cost_usd|wholesale|internalMargins|providerCost|providerCostUsd)\b/i.test(text)
    || /\binternal\s+margin/i.test(text)
    || /\bmargin\s*%/i.test(text);
}
