/**
 * Branded Sync2Dine sales email HTML shell (email-safe tables + inline CSS).
 * Marketing layout: hero image, package cards, website CTA, signature footer.
 */

import { SAAS_PACKAGES, type SaasPackageId } from './saas-packages';

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
  /** Absolute URL for hero photo (defaults to live app asset). */
  heroImageUrl?: string;
  /** Absolute URL for header logo (optional; text fallback is always shown). */
  logoUrl?: string;
  /** Show launch package cards under the body. Default true. */
  showPackages?: boolean;
  /** Package ids to feature. Defaults to primary sales set. */
  packageIds?: SaasPackageId[];
};

const DEFAULT_HERO_IMAGE =
  'https://app.sync2dine.io/quote-assets/sync2dine-phone-agent.jpg';
const DEFAULT_CTA_URL = 'https://sync2dine.io';
const DEFAULT_PACKAGE_IDS: SaasPackageId[] = [
  'atmosphere',
  'judie_starter',
  'judie_payg_inbound',
  'combined',
];

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

function buildPackageCards(ids: SaasPackageId[]): string {
  const cards = ids
    .map((id) => SAAS_PACKAGES[id])
    .filter(Boolean)
    .map((pkg) => {
      const badge = pkg.badge
        ? `<div style="display:inline-block;background:#ecfdf5;color:#0f766e;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;padding:4px 8px;border-radius:999px;margin-bottom:8px;">${escapeHtml(pkg.badge)}</div>`
        : '';
      return `<td width="50%" valign="top" style="padding:6px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f4;border:1px solid #e7e0d4;border-radius:8px;">
    <tr><td style="padding:16px 14px;">
      ${badge}
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#0f3d3a;margin:0 0 4px;">${escapeHtml(pkg.name)}</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.4;color:#78716c;margin:0 0 10px;">${escapeHtml(pkg.description)}</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:#0f766e;">£${pkg.launchWeeklyGbp}<span style="font-size:13px;font-weight:600;color:#57534e;">/wk launch</span></div>
    </td></tr>
  </table>
</td>`;
    });

  if (!cards.length) return '';

  const rows: string[] = [];
  for (let i = 0; i < cards.length; i += 2) {
    const left = cards[i];
    const right = cards[i + 1] || '<td width="50%" style="padding:6px;"></td>';
    rows.push(`<tr>${left}${right}</tr>`);
  }

  return `<tr>
  <td style="padding:4px 32px 8px;">
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#0f766e;margin:0 0 10px;">Launch packages</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#78716c;margin:8px 0 0;line-height:1.45;">
      All weekly rolling — cancel anytime after the first month with 30 days notice.
    </div>
  </td>
</tr>`;
}

export function buildSalesEmailHtml(opts: SalesEmailHtmlOpts): string {
  const company = opts.companyName || 'Sync2Dine';
  const tagline = opts.tagline || 'Voice ordering & bookings for restaurants';
  const hero = opts.heroTitle || opts.subject || company;
  const phone = opts.companyPhone || '020 3745 3233';
  const email = opts.companyEmail || 'info@sync2dine.io';
  const website = opts.companyWebsite || DEFAULT_CTA_URL;
  const sentBy = opts.sentBy || 'Sally · Sync2Dine';
  const ctaUrl = opts.ctaUrl || website;
  const ctaLabel = opts.ctaLabel || 'See Sync2Dine';
  const heroImage = opts.heroImageUrl || DEFAULT_HERO_IMAGE;
  const showPackages = opts.showPackages !== false;
  const packageIds = opts.packageIds?.length ? opts.packageIds : DEFAULT_PACKAGE_IDS;

  const logoBlock = opts.logoUrl
    ? `<img src="${escapeHtml(opts.logoUrl)}" alt="${escapeHtml(company)}" width="160" height="36" style="display:block;border:0;outline:none;text-decoration:none;height:36px;width:auto;max-width:180px;" />`
    : `<div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;letter-spacing:0.02em;color:#f8faf9;">${escapeHtml(company)}</div>`;

  const packagesBlock = showPackages ? buildPackageCards(packageIds) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="light"/>
  <title>${escapeHtml(hero)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    ${escapeHtml(hero)} — Judie answers every call. Atmosphere runs the floor.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e7e0d4;">
        <tr>
          <td style="background:#0f3d3a;padding:26px 32px 20px;">
            ${logoBlock}
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#a7d4cf;margin-top:8px;">${escapeHtml(tagline)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:0;line-height:0;font-size:0;">
            <img src="${escapeHtml(heroImage)}" alt="Sync2Dine AI phone ordering" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;" />
          </td>
        </tr>
        <tr>
          <td style="background:linear-gradient(#134e4a,#134e4a);background-color:#134e4a;padding:16px 32px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:#ecfdf5;line-height:1.35;">${escapeHtml(hero)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 12px;">
            ${textToParagraphs(opts.bodyText)}
          </td>
        </tr>
        ${packagesBlock}
        <tr>
          <td style="padding:16px 32px 8px;" align="center">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" bgcolor="#0f766e" style="border-radius:6px;">
                  <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;padding:14px 28px;border-radius:6px;">
                    ${escapeHtml(ctaLabel)}
                  </a>
                </td>
              </tr>
            </table>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#a8a29e;margin-top:10px;">
              Or visit <a href="${escapeHtml(website)}" style="color:#0f766e;text-decoration:none;">${escapeHtml(website.replace(/^https?:\/\//, ''))}</a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 28px;">
            <div style="height:1px;background:#e7e0d4;margin:4px 0 20px;"></div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#57534e;">
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

export function wrapSalesEmail(
  bodyText: string,
  opts?: Partial<SalesEmailHtmlOpts>,
): { text: string; html: string } {
  const text = String(bodyText || '').trim();
  return {
    text,
    html: buildSalesEmailHtml({
      ctaUrl: DEFAULT_CTA_URL,
      ctaLabel: 'See Sync2Dine',
      showPackages: true,
      ...opts,
      bodyText: text,
    }),
  };
}
