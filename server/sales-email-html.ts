/**
 * Branded Sync2Dine sales email HTML shell (email-safe tables + inline CSS).
 */

export type SalesEmailHtmlOpts = {
  subject?: string;
  bodyText: string;
  heroTitle?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  companyName?: string;
  companyPhone?: string;
  companyEmail?: string;
  companyWebsite?: string;
  tagline?: string;
  sentBy?: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textToParagraphs(body: string): string {
  const blocks = body.replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return '<p style="margin:0 0 16px;color:#1c1917;font-size:16px;line-height:1.55;"> </p>';
  return blocks
    .map((block) => {
      const withBreaks = escapeHtml(block).replace(/\n/g, '<br/>');
      return `<p style="margin:0 0 16px;color:#1c1917;font-size:16px;line-height:1.55;font-family:Georgia,'Times New Roman',serif;">${withBreaks}</p>`;
    })
    .join('');
}

export function buildSalesEmailHtml(opts: SalesEmailHtmlOpts): string {
  const company = opts.companyName || 'Sync2Dine';
  const tagline = opts.tagline || 'Voice ordering & bookings for restaurants';
  const hero = opts.heroTitle || opts.subject || company;
  const phone = opts.companyPhone || '020 3745 3233';
  const email = opts.companyEmail || 'info@sync2dine.io';
  const website = opts.companyWebsite || 'https://sync2dine.io';
  const sentBy = opts.sentBy || 'Sally · Sync2Dine';

  const ctaBlock = opts.ctaUrl
    ? `<tr><td style="padding:8px 0 24px;">
        <a href="${escapeHtml(opts.ctaUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;padding:12px 22px;border-radius:4px;">
          ${escapeHtml(opts.ctaLabel || 'Open link')}
        </a>
      </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f5f0e8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e7e0d4;">
        <tr>
          <td style="background:#0f3d3a;padding:28px 32px 22px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;letter-spacing:0.04em;color:#f8faf9;">${escapeHtml(company)}</div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#a7d4cf;margin-top:6px;">${escapeHtml(tagline)}</div>
          </td>
        </tr>
        <tr>
          <td style="background:#134e4a;padding:14px 32px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#ecfdf5;">${escapeHtml(hero)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 8px;">
            ${textToParagraphs(opts.bodyText)}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${ctaBlock}</table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 28px;">
            <div style="height:1px;background:#e7e0d4;margin:8px 0 20px;"></div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#57534e;">
              <strong style="color:#0f3d3a;">${escapeHtml(company)}</strong><br/>
              ${escapeHtml(phone)} · <a href="mailto:${escapeHtml(email)}" style="color:#0f766e;text-decoration:none;">${escapeHtml(email)}</a><br/>
              <a href="${escapeHtml(website)}" style="color:#0f766e;text-decoration:none;">${escapeHtml(website.replace(/^https?:\/\//, ''))}</a>
            </div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#78716c;margin-top:14px;">
              ${escapeHtml(sentBy)} — helping restaurants answer every call.
            </div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#a8a29e;margin-top:10px;">
              You're receiving this because you spoke with Sync2Dine about our service. Reply to this email anytime.
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function wrapSalesEmail(bodyText: string, opts?: Partial<SalesEmailHtmlOpts>): { text: string; html: string } {
  return {
    text: bodyText,
    html: buildSalesEmailHtml({ ...opts, bodyText }),
  };
}
