/**
 * OpenAI-only restaurant business research for Sally (platform sales).
 * Uses Company AI Brain (Settings → Integrations → OpenAI) via resolveCompanyAiBrainOpenAIKey.
 */
import {
  mapOpenAIError,
  resolveCompanyAiBrainOpenAIKey,
  OpenAIConnectionError,
} from './openai-connection';
import { getHomeOrgId } from './home-org';

export type RestaurantProfileField =
  | 'businessName'
  | 'address'
  | 'phone'
  | 'openingHours'
  | 'deliveryAvailable'
  | 'collectionAvailable'
  | 'deliveryAreas'
  | 'menuUrl'
  | 'paymentMethods'
  | 'reservations'
  | 'website'
  | 'socialMedia'
  | 'contactEmail';

export type RestaurantProfileDraft = {
  businessName?: string;
  address?: string;
  phone?: string;
  openingHours?: string;
  deliveryAvailable?: boolean | null;
  collectionAvailable?: boolean | null;
  deliveryAreas?: string;
  menuUrl?: string;
  paymentMethods?: string;
  reservations?: boolean | null;
  website?: string;
  socialMedia?: string;
  contactEmail?: string;
  sources?: Partial<Record<RestaurantProfileField, string>>;
  confidence?: Partial<Record<RestaurantProfileField, 'high' | 'medium' | 'low'>>;
  rawSummary?: string;
  researchedAt?: string;
  /** Fields the owner confirmed on the call */
  confirmedFields?: string[];
};

export type ResearchRestaurantInput = {
  businessName?: string;
  phone?: string;
  website?: string;
  addressHint?: string;
  orgId?: string;
};

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const output = payload.output;
  if (Array.isArray(output)) {
    const chunks: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const content = row.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== 'object') continue;
          const part = c as Record<string, unknown>;
          if (typeof part.text === 'string') chunks.push(part.text);
        }
      }
      if (typeof row.text === 'string') chunks.push(row.text);
    }
    if (chunks.length) return chunks.join('\n').trim();
  }
  if (typeof payload.content === 'string') return payload.content.trim();
  return '';
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const direct = JSON.parse(trimmed) as unknown;
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const sliced = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      if (sliced && typeof sliced === 'object' && !Array.isArray(sliced)) {
        return sliced as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['yes', 'true', 'y', '1'].includes(s)) return true;
    if (['no', 'false', 'n', '0'].includes(s)) return false;
  }
  return null;
}

function normalizeDraft(raw: Record<string, unknown>, fallback: ResearchRestaurantInput): RestaurantProfileDraft {
  const sources = (raw.sources && typeof raw.sources === 'object'
    ? raw.sources
    : {}) as Partial<Record<RestaurantProfileField, string>>;
  const confidence = (raw.confidence && typeof raw.confidence === 'object'
    ? raw.confidence
    : {}) as Partial<Record<RestaurantProfileField, 'high' | 'medium' | 'low'>>;

  return {
    businessName: String(raw.businessName ?? fallback.businessName ?? '').trim() || undefined,
    address: String(raw.address ?? fallback.addressHint ?? '').trim() || undefined,
    phone: String(raw.phone ?? fallback.phone ?? '').trim() || undefined,
    openingHours: String(raw.openingHours ?? '').trim() || undefined,
    deliveryAvailable: asBool(raw.deliveryAvailable),
    collectionAvailable: asBool(raw.collectionAvailable),
    deliveryAreas: String(raw.deliveryAreas ?? '').trim() || undefined,
    menuUrl: String(raw.menuUrl ?? '').trim() || undefined,
    paymentMethods: String(raw.paymentMethods ?? '').trim() || undefined,
    reservations: asBool(raw.reservations),
    website: String(raw.website ?? fallback.website ?? '').trim() || undefined,
    socialMedia: String(raw.socialMedia ?? '').trim() || undefined,
    contactEmail: String(raw.contactEmail ?? '').trim() || undefined,
    sources,
    confidence,
    rawSummary: String(raw.rawSummary ?? '').trim() || undefined,
    researchedAt: new Date().toISOString(),
  };
}

async function openaiResponsesSearch(apiKey: string, query: string): Promise<string> {
  const models = [
    process.env.OPENAI_RESEARCH_MODEL?.trim() || '',
    'gpt-4o',
    'gpt-4.1',
  ].filter(Boolean);

  const toolVariants: Array<Array<Record<string, unknown>>> = [
    [{ type: 'web_search' }],
    [{ type: 'web_search_preview' }],
  ];

  let lastError = 'Responses API failed';
  for (const model of models) {
    for (const tools of toolVariants) {
      try {
        const res = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            tools,
            input: query,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          lastError = String(data.error && typeof data.error === 'object'
            ? (data.error as { message?: string }).message
            : data.error || res.statusText || `HTTP ${res.status}`);
          continue;
        }
        const text = extractOutputText(data);
        if (text) return text;
        lastError = 'Empty Responses output';
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  throw new Error(lastError);
}

async function openaiJsonExtract(
  orgId: string | null,
  apiKey: string,
  researchText: string,
  input: ResearchRestaurantInput,
): Promise<RestaurantProfileDraft> {
  const system = [
    'You extract UK restaurant / takeaway business profile fields from research notes.',
    'Return ONLY a JSON object with keys:',
    'businessName, address, phone, openingHours, deliveryAvailable, collectionAvailable,',
    'deliveryAreas, menuUrl, paymentMethods, reservations, website, socialMedia, contactEmail,',
    'sources (object field→url), confidence (object field→high|medium|low), rawSummary.',
    'Use null for unknown booleans. Prefer public sources. Do not invent precise hours if unsure — leave empty.',
  ].join(' ');

  const user = [
    `Known hints: name=${input.businessName || 'unknown'}; phone=${input.phone || 'unknown'}; website=${input.website || 'unknown'}; area=${input.addressHint || 'unknown'}.`,
    'Research notes:',
    researchText.slice(0, 12000),
  ].join('\n');

  // Metered LLM client — Company AI Brain (DeepSeek or OpenAI text extract).
  const { createLLMClientForOrg, defaultChatModelForProvider } = await import('./llm-connection');
  const { client: openai, provider } = await createLLMClientForOrg(
    orgId,
    '/api/ai/restaurant-research',
    { bodyOpenAIApiKey: apiKey },
  );
  const model = defaultChatModelForProvider(
    provider,
    process.env.OPENAI_RESEARCH_MODEL?.trim(),
  );

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJsonObject(content);
    if (!parsed) {
      return normalizeDraft({ rawSummary: researchText.slice(0, 800) }, input);
    }
    return normalizeDraft(parsed, input);
  } catch (err) {
    throw mapOpenAIError(err);
  }
}

/**
 * Research a restaurant from public web via Company AI Brain OpenAI key.
 */
export async function researchRestaurantProfile(
  input: ResearchRestaurantInput,
): Promise<{ ok: true; draft: RestaurantProfileDraft; spokenHint: string } | { ok: false; error: string; spokenHint: string }> {
  try {
    const preferredOrgId = input.orgId || getHomeOrgId();
    const { apiKey, orgId } = await resolveCompanyAiBrainOpenAIKey(preferredOrgId);

    const query = [
      'Find public business details for this UK restaurant or takeaway for onboarding.',
      input.businessName ? `Business name: ${input.businessName}.` : '',
      input.phone ? `Phone: ${input.phone}.` : '',
      input.website ? `Website: ${input.website}.` : '',
      input.addressHint ? `Area/address hint: ${input.addressHint}.` : '',
      'Prefer official website and Google Business / Maps listings.',
      'Collect: business name, address, phone, opening hours, delivery/collection, delivery areas,',
      'menu page or PDF link, payment methods, whether they take reservations, website, social media.',
      'Cite URLs where possible. Keep the answer factual and compact.',
    ].filter(Boolean).join(' ');

    let researchText = '';
    try {
      researchText = await openaiResponsesSearch(apiKey, query);
    } catch (searchErr) {
      // Fallback: model-only extract from hints (no live browse) — still structured.
      researchText = [
        'Live web search unavailable; use hints only and mark confidence low.',
        `Error: ${searchErr instanceof Error ? searchErr.message : String(searchErr)}`,
        `Hints: ${JSON.stringify(input)}`,
      ].join('\n');
    }

    const draft = await openaiJsonExtract(orgId, apiKey, researchText, input);
    const name = draft.businessName || input.businessName || 'the restaurant';
    const hoursBit = draft.openingHours
      ? `We've found these opening hours: ${draft.openingHours}. Are they correct?`
      : `I found some public details for ${name}. Shall I read the address and hours for you to confirm?`;

    return {
      ok: true,
      draft,
      spokenHint: hoursBit,
    };
  } catch (err) {
    const mapped = mapOpenAIError(err);
    const missing = mapped instanceof OpenAIConnectionError && mapped.code === 'missing';
    return {
      ok: false,
      error: mapped.message,
      spokenHint: missing
        ? 'OpenAI is not connected — ask the platform owner to add the Company AI Brain key in Settings, Integrations, then try again.'
        : 'I could not look them up online just now — ask for the website or opening hours and I will note them.',
    };
  }
}

export function spokenConfirmForField(
  field: RestaurantProfileField,
  draft: RestaurantProfileDraft,
): string {
  const labels: Record<RestaurantProfileField, string> = {
    businessName: 'business name',
    address: 'address',
    phone: 'phone number',
    openingHours: 'opening hours',
    deliveryAvailable: 'delivery',
    collectionAvailable: 'collection',
    deliveryAreas: 'delivery areas',
    menuUrl: 'menu link',
    paymentMethods: 'payment methods',
    reservations: 'reservations',
    website: 'website',
    socialMedia: 'social media',
    contactEmail: 'contact email',
  };
  const label = labels[field] || field;
  const value = draft[field];
  if (value === undefined || value === null || value === '') {
    return `I do not have ${label} yet — what should I put?`;
  }
  if (typeof value === 'boolean') {
    return `We've got ${label} as ${value ? 'yes' : 'no'}. Is that correct?`;
  }
  return `We've found these ${label}: ${String(value)}. Are they correct?`;
}

export function draftToAboutUs(draft: RestaurantProfileDraft): string {
  const lines = [
    draft.businessName ? `Business: ${draft.businessName}` : '',
    draft.address ? `Address: ${draft.address}` : '',
    draft.phone ? `Phone: ${draft.phone}` : '',
    draft.openingHours ? `Hours: ${draft.openingHours}` : '',
    draft.collectionAvailable != null ? `Collection: ${draft.collectionAvailable ? 'yes' : 'no'}` : '',
    draft.deliveryAvailable != null ? `Delivery: ${draft.deliveryAvailable ? 'yes' : 'no'}` : '',
    draft.deliveryAreas ? `Delivery areas: ${draft.deliveryAreas}` : '',
    draft.paymentMethods ? `Payments: ${draft.paymentMethods}` : '',
    draft.reservations != null ? `Reservations: ${draft.reservations ? 'yes' : 'no'}` : '',
    draft.website ? `Website: ${draft.website}` : '',
    draft.socialMedia ? `Social: ${draft.socialMedia}` : '',
    draft.menuUrl ? `Menu: ${draft.menuUrl}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}
