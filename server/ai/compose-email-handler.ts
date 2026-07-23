/**
 * AI compose for Sync2Dine / Sally sales emails — subject + body only (HTML wrapper separate).
 */
import { createLLMClientForOrg, defaultChatModelForProvider } from './llm-connection';
import { resolveOrgIdFromBody } from '../org-context';
import { getSallyOfferStored } from '../sally-offer-store';
import { getSalesTemplate, renderSalesPlaceholders } from '../sales-templates';

export type ComposeEmailBody = {
  purpose?: string;
  templateId?: string;
  customerName?: string;
  restaurantName?: string;
  notes?: string;
  tone?: string;
  rewrite?: string;
  channel?: string;
  apiKey?: string;
  orgId?: string;
  model?: string;
};

function offerFactsBlock(): string {
  const t = getSallyOfferStored();
  const monthly = Number.isFinite(Number(t.monthlyPriceGbp)) && Number(t.monthlyPriceGbp)! > 0
    ? Number(t.monthlyPriceGbp)
    : Number(process.env.SALLY_INTRO_MONTHLY_GBP) || 350;
  const setup = Number.isFinite(Number(t.setupFeeGbp)) && Number(t.setupFeeGbp)! >= 0
    ? Number(t.setupFeeGbp)
    : Number(process.env.SALLY_SETUP_FEE_GBP) || 0;
  const lines = [
    'AUTHORITATIVE OFFER FACTS (never invent different prices):',
    `- Monthly: £${monthly}`,
    `- Setup: £${setup}`,
    `- Term: ${(t.minimumTerm || process.env.SALLY_MINIMUM_TERM || '1 month rolling').trim()}`,
    `- Cancel: ${(t.cancelPolicy || process.env.SALLY_CANCEL_POLICY || 'Cancel anytime with 30 days written notice after the first month.').trim()}`,
  ];
  if (t.demoPhone || process.env.SALLY_DEMO_PHONE) {
    lines.push(`- Demo phone: ${(t.demoPhone || process.env.SALLY_DEMO_PHONE || '').trim()}`);
  }
  if (t.demoVideoUrl || process.env.SALLY_DEMO_VIDEO_URL) {
    lines.push(`- Demo video: ${(t.demoVideoUrl || process.env.SALLY_DEMO_VIDEO_URL || '').trim()}`);
  }
  if (t.salesPdfUrl || process.env.SALLY_SALES_PDF_URL) {
    lines.push(`- Sales PDF: ${(t.salesPdfUrl || process.env.SALLY_SALES_PDF_URL || '').trim()}`);
  }
  return lines.join('\n');
}

function buildOfferVariables(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const t = getSallyOfferStored();
  const monthly = String(
    Number.isFinite(Number(t.monthlyPriceGbp)) && Number(t.monthlyPriceGbp)! > 0
      ? t.monthlyPriceGbp
      : Number(process.env.SALLY_INTRO_MONTHLY_GBP) || 350,
  );
  const setupNum = Number.isFinite(Number(t.setupFeeGbp)) && Number(t.setupFeeGbp)! >= 0
    ? Number(t.setupFeeGbp)
    : Number(process.env.SALLY_SETUP_FEE_GBP) || 0;
  const demoPhone = (t.demoPhone || process.env.SALLY_DEMO_PHONE || '').trim();
  const demoVideo = (t.demoVideoUrl || process.env.SALLY_DEMO_VIDEO_URL || '').trim();
  const salesPdf = (t.salesPdfUrl || process.env.SALLY_SALES_PDF_URL || '').trim();
  const assets: string[] = [];
  if (demoVideo) assets.push(`Demo video: ${demoVideo}`);
  if (salesPdf) assets.push(`Overview PDF: ${salesPdf}`);
  if (demoPhone) assets.push(`Demo phone: ${demoPhone}`);

  return {
    COMPANY_NAME: 'Sync2Dine',
    COMPANY_PHONE: '020 3745 3233',
    COMPANY_EMAIL: 'info@sync2dine.io',
    COMPANY_WEBSITE: 'https://sync2dine.io',
    USER_NAME: 'Sally',
    MONTHLY_PRICE: monthly,
    SETUP_FEE: String(setupNum),
    SETUP_FEE_LINE: setupNum > 0 ? ` plus £${setupNum} setup` : '',
    MINIMUM_TERM: (t.minimumTerm || process.env.SALLY_MINIMUM_TERM || '1 month rolling').trim(),
    CANCEL_POLICY: (t.cancelPolicy || process.env.SALLY_CANCEL_POLICY || 'Cancel anytime with 30 days written notice after the first month.').trim(),
    DEMO_PHONE: demoPhone || 'our demo line',
    DEMO_VIDEO_URL: demoVideo,
    SALES_PDF_URL: salesPdf,
    ASSETS_BLOCK: assets.length ? assets.join('\n') : '(Assets will be shared separately)',
    CHECKOUT_LINK: '{CHECKOUT_LINK}',
    ...extra,
  };
}

export async function handleComposeEmail(
  body: ComposeEmailBody,
): Promise<{ subject: string; body: string; templateId?: string }> {
  const orgId = resolveOrgIdFromBody(body);
  const template = body.templateId ? getSalesTemplate(body.templateId) : undefined;
  const vars = buildOfferVariables({
    CUSTOMER_NAME: body.customerName || 'there',
    RESTAURANT_NAME: body.restaurantName || 'your restaurant',
  });

  // Template-only fill without LLM when notes empty and template selected
  if (template && !body.notes?.trim() && !body.rewrite?.trim() && !body.purpose?.trim()) {
    return {
      subject: renderSalesPlaceholders(template.subject, vars),
      body: renderSalesPlaceholders(template.body, vars),
      templateId: template.id,
    };
  }

  const { client, provider } = await createLLMClientForOrg(orgId, '/api/ai/compose-email', {
    bodyOpenAIApiKey: body.apiKey,
  });
  const model = defaultChatModelForProvider(provider, body.model ?? 'gpt-4o-mini');

  const system = `You are Sally, sales receptionist for Sync2Dine (sync2dine.io) — UK B2B SaaS that sells voice AI ordering and table bookings to restaurants.
Write professional email subject + body in clear UK English. Confident, warm, not hypey. No HTML.
${offerFactsBlock()}
Never invent prices or terms different from the offer facts.
Output JSON only: {"subject":"...","body":"..."} with body using short paragraphs separated by blank lines.
Sign off as Sally / Sync2Dine when writing the body.`;

  const userParts = [
    body.templateId ? `Template hint: ${body.templateId} (${template?.name || 'custom'})` : 'Free-form company email (no fixed template).',
    body.customerName ? `Recipient name: ${body.customerName}` : '',
    body.restaurantName ? `Restaurant: ${body.restaurantName}` : '',
    body.tone ? `Tone: ${body.tone}` : '',
    body.purpose ? `Purpose: ${body.purpose}` : '',
    body.notes ? `Instructions from the platform owner: ${body.notes}` : '',
    body.rewrite ? `Rewrite / improve this draft:\n${body.rewrite}` : '',
    template
      ? `Starting structure (adapt freely to instructions):\nSubject: ${renderSalesPlaceholders(template.subject, vars)}\n\n${renderSalesPlaceholders(template.body, vars)}`
      : '',
  ].filter(Boolean);

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.5,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userParts.join('\n\n') },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() || '{}';
  let parsed: { subject?: string; body?: string };
  try {
    parsed = JSON.parse(raw) as { subject?: string; body?: string };
  } catch {
    throw new Error('AI returned invalid compose JSON');
  }
  const subject = String(parsed.subject || '').trim();
  const emailBody = String(parsed.body || '').trim();
  if (!subject || !emailBody) {
    throw new Error('AI compose missing subject or body');
  }
  return { subject, body: emailBody, templateId: template?.id };
}

export { buildOfferVariables };
