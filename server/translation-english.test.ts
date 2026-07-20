/**
 * Translation gateway + English customer-send guard + language-pack allowlist.
 * Run: npm test  (or: npx tsx --test server/translation-english.test.ts)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLang,
  SUPPORTED_LANGS,
  deepgramLanguageForPack,
} from './language-packs';
import {
  detectLanguage,
  translateToEnglish,
  translateFromEnglish,
  translateToEnglishStrict,
  clearTranslationCacheForTests,
  __setTranslationClientFactoryForTests,
} from './translation-service';
import { ensureEnglishForCustomerSend, ensureEnglishFields } from './outbound-english-guard';
import { resolveInboundChannel } from './channel-router';
import { upsertTeamMember, listTeamMembers } from './conversation-store';
import { setRequestOrgId } from './data-store';

function fakeClient(map: Record<string, string>) {
  return {
    chat: {
      completions: {
        create: async (params: { messages?: Array<{ role?: string; content?: string }> }) => {
          const user = params.messages?.find((m) => m.role === 'user')?.content ?? '';
          const system = params.messages?.find((m) => m.role === 'system')?.content ?? '';
          for (const [key, value] of Object.entries(map)) {
            if (user.includes(key) || system.includes(key)) {
              return { choices: [{ message: { content: value } }] };
            }
          }
          const hit = map[user];
          if (hit !== undefined) return { choices: [{ message: { content: hit } }] };
          return { choices: [{ message: { content: map['*'] ?? user } }] };
        },
      },
    },
  };
}

describe('normalizeLang allowlist', () => {
  it('includes ru and maps aliases to supported codes', () => {
    assert.ok((SUPPORTED_LANGS as readonly string[]).includes('ru'));
    assert.equal(normalizeLang('ru'), 'ru');
    assert.equal(normalizeLang('ru-RU'), 'ru');
    assert.equal(normalizeLang('uk'), 'uk');
    assert.equal(normalizeLang('xx'), 'en');
    assert.equal(normalizeLang(null), 'en');
  });
});

describe('detectLanguage uk vs ru heuristics', () => {
  it('detects Ukrainian via ї/є/ґ', async () => {
    assert.equal(await detectLanguage('Добрий день, як справи? Її є'), 'uk');
    assert.equal(await detectLanguage('Привіт, це для ґаража'), 'uk');
  });

  it('detects Russian via ъ/э/ё', async () => {
    assert.equal(await detectLanguage('Подъезд закрыт — это для вас'), 'ru');
    assert.equal(await detectLanguage('Ёлка стоит у дома'), 'ru');
  });

  it('defaults ambiguous Cyrillic to ru', async () => {
    assert.equal(await detectLanguage('Здравствуйте нужно помочь'), 'ru');
  });
});

describe('translateToEnglish / translateFromEnglish', () => {
  beforeEach(() => {
    clearTranslationCacheForTests();
    __setTranslationClientFactoryForTests(async () =>
      fakeClient({
        'Potrzebuję wyceny': 'I need a quote',
        'I need a quote': 'Potrzebuję wyceny',
        '*': 'FALLBACK',
      }),
    );
  });

  afterEach(() => {
    __setTranslationClientFactoryForTests(null);
    clearTranslationCacheForTests();
  });

  it('translates to English on success', async () => {
    const out = await translateToEnglish('Potrzebuję wyceny łazienki', 'pl', 'org-test');
    assert.equal(out, 'I need a quote');
  });

  it('falls back to original text when the model fails', async () => {
    __setTranslationClientFactoryForTests(async () => {
      throw new Error('network down');
    });
    const out = await translateToEnglish('Potrzebuję wyceny', 'pl', 'org-test');
    assert.equal(out, 'Potrzebuję wyceny');
  });

  it('translateFromEnglish succeeds and falls back to English on failure', async () => {
    const ok = await translateFromEnglish('I need a quote', 'pl', 'org-test');
    assert.equal(ok, 'Potrzebuję wyceny');

    __setTranslationClientFactoryForTests(async () => {
      throw new Error('timeout');
    });
    clearTranslationCacheForTests();
    const fallback = await translateFromEnglish('Please confirm the survey', 'pl', 'org-test');
    assert.equal(fallback, 'Please confirm the survey');
  });

  it('translateToEnglishStrict throws on failure', async () => {
    __setTranslationClientFactoryForTests(async () => {
      throw new Error('boom');
    });
    await assert.rejects(
      () => translateToEnglishStrict('Potrzebuję wyceny', 'pl', 'org-test'),
      /boom|timed out|empty/i,
    );
  });
});

describe('ensureEnglishForCustomerSend', () => {
  beforeEach(() => {
    clearTranslationCacheForTests();
  });

  afterEach(() => {
    __setTranslationClientFactoryForTests(null);
    clearTranslationCacheForTests();
  });

  it('ok when source is already English', async () => {
    const result = await ensureEnglishForCustomerSend('Hello customer', 'en');
    assert.equal(result.ok, true);
    assert.equal(result.english, 'Hello customer');
  });

  it('ok when translation succeeds', async () => {
    __setTranslationClientFactoryForTests(async () =>
      fakeClient({ 'Cześć': 'Hello there', '*': 'Hello there' }),
    );
    const result = await ensureEnglishForCustomerSend('Cześć, potrzebuję pomocy', 'pl', 'org-test');
    assert.equal(result.ok, true);
    assert.equal(result.english, 'Hello there');
  });

  it('blocks send when translation fails', async () => {
    __setTranslationClientFactoryForTests(async () => {
      throw new Error('openai unavailable');
    });
    const result = await ensureEnglishForCustomerSend('Cześć klient', 'pl', 'org-test');
    assert.equal(result.ok, false);
    assert.equal(result.english, 'Cześć klient');
  });

  it('ensureEnglishFields translates body for sendQuote-style payloads', async () => {
    __setTranslationClientFactoryForTests(async () =>
      fakeClient({ '*': 'Please find your quote attached.' }),
    );
    const result = await ensureEnglishFields(
      { quoteId: 'Q1', body: 'Proszę znaleźć wycenę w załączniku.' },
      ['body', 'subject'],
      'pl',
      'org-test',
    );
    assert.equal(result.ok, true);
    assert.equal(result.input.body, 'Please find your quote attached.');
    assert.equal(result.input.quoteId, 'Q1');
  });
});

describe('channel-router preferredLanguage for staff', () => {
  it('propagates staff preferredLanguage including ru', () => {
    setRequestOrgId('default');
    const phone = '447700900111';
    upsertTeamMember({
      id: 'tm-lang-test',
      userId: 'user-lang-test',
      name: 'Ivan Staff',
      phone,
      role: 'staff',
      preferredLanguage: 'ru',
    });
    const members = listTeamMembers();
    assert.ok(members.some((m) => m.phone.replace(/\D/g, '').endsWith('7700900111') || m.id === 'tm-lang-test'));
    const route = resolveInboundChannel(phone);
    assert.equal(route.mode, 'staff');
    assert.equal(route.preferredLanguage, 'ru');
  });
});

describe('language-packs SUPPORTED_LANGS / deepgram', () => {
  it('SUPPORTED_LANGS includes ru and deepgram maps it', () => {
    assert.deepEqual(
      [...SUPPORTED_LANGS].sort(),
      ['ar', 'en', 'es', 'fa', 'hi', 'it', 'pl', 'pt', 'ro', 'ru', 'sq', 'tr', 'uk', 'zh'].sort(),
    );
    assert.equal(deepgramLanguageForPack('ru'), 'multi');
    assert.equal(deepgramLanguageForPack('uk'), 'multi');
    assert.equal(deepgramLanguageForPack('en'), 'multi');
  });
});
