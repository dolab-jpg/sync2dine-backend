import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSallyWebPrompt } from './prompts';
import { getSallyWebOrchestratorTools, SALLY_WEB_BLOCKED_TOOLS } from './tools';
import { formatOfferFactsBlock } from './offer';

describe('Sally web channel', () => {
  it('web prompt identifies Sally and Sync2Dine offer path', () => {
    const prompt = buildSallyWebPrompt({ page: '/' });
    assert.match(prompt, /Sally/);
    assert.match(prompt, /Sync2Dine/);
    assert.match(prompt, /getOfferTerms|OFFER FACTS/i);
    assert.doesNotMatch(prompt, /You are Cynthia/i);
  });

  it('shared offer facts include package pricing lines', () => {
    const facts = formatOfferFactsBlock();
    assert.match(facts, /PACKAGES|Judie|Atmosphere/i);
    assert.match(facts, /£|GBP|\/wk/i);
  });

  it('web tools exclude outbound blast and provision', () => {
    const tools = getSallyWebOrchestratorTools();
    const names = tools.map((t) => String((t as { function?: { name?: string } }).function?.name || ''));
    assert.ok(names.includes('getOfferTerms'));
    for (const blocked of SALLY_WEB_BLOCKED_TOOLS) {
      assert.equal(names.includes(blocked), false, `should block ${blocked}`);
    }
  });
});
