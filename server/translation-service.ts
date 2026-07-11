const SUPPORTED = new Set(['sq', 'uk', 'zh', 'es', 'pl', 'fa', 'en']);

const LANG_NAMES: Record<string, string> = {
  sq: 'Albanian',
  uk: 'Ukrainian',
  zh: 'Chinese',
  es: 'Spanish',
  pl: 'Polish',
  fa: 'Farsi',
  en: 'English',
};

function normalizeLang(code: string | null | undefined): string {
  const c = (code ?? 'en').toLowerCase().split('-')[0];
  return SUPPORTED.has(c) ? c : 'en';
}

async function openaiTranslate(text: string, targetLang: string, sourceLang?: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const target = normalizeLang(targetLang);
  if (target === 'en' && (!sourceLang || normalizeLang(sourceLang) === 'en')) return trimmed;

  const { resolveOpenAIApiKey } = await import('./openai-connection');
  const apiKey = resolveOpenAIApiKey();
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });

  const targetName = LANG_NAMES[target] ?? target;
  const sourceHint = sourceLang && normalizeLang(sourceLang) !== 'en'
    ? ` from ${LANG_NAMES[normalizeLang(sourceLang)] ?? sourceLang}`
    : '';

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Translate${sourceHint} to ${targetName}. Output only the translation, no quotes or explanation.`,
      },
      { role: 'user', content: trimmed },
    ],
    max_tokens: 1500,
  });
  return completion.choices[0]?.message?.content?.trim() ?? trimmed;
}

export async function detectLanguage(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return 'en';
  if (trimmed.length < 4) return 'en';

  try {
    const { resolveOpenAIApiKey } = await import('./openai-connection');
    const apiKey = resolveOpenAIApiKey();
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Detect ISO 639-1 language code. Reply with code only: sq, uk, zh, es, pl, fa, or en.`,
        },
        { role: 'user', content: trimmed.slice(0, 500) },
      ],
      max_tokens: 10,
    });
    const code = completion.choices[0]?.message?.content?.trim().toLowerCase() ?? 'en';
    return normalizeLang(code);
  } catch {
    return 'en';
  }
}

export async function translateToEnglish(text: string, fromLang?: string): Promise<string> {
  const lang = normalizeLang(fromLang);
  if (lang === 'en') return text;
  return openaiTranslate(text, 'en', lang);
}

export async function translateFromEnglish(text: string, toLang: string): Promise<string> {
  const lang = normalizeLang(toLang);
  if (lang === 'en') return text;
  return openaiTranslate(text, lang, 'en');
}

export async function normalizeInboundText(
  text: string,
  preferredLanguage?: string | null
): Promise<{ english: string; detectedLanguage: string; original: string }> {
  const detected = preferredLanguage ? normalizeLang(preferredLanguage) : await detectLanguage(text);
  if (detected === 'en') {
    return { english: text, detectedLanguage: 'en', original: text };
  }
  const english = await translateToEnglish(text, detected);
  return { english, detectedLanguage: detected, original: text };
}

export async function localizeOutboundText(
  englishText: string,
  targetLanguage?: string | null
): Promise<string> {
  const lang = normalizeLang(targetLanguage);
  if (lang === 'en') return englishText;
  return translateFromEnglish(englishText, lang);
}
