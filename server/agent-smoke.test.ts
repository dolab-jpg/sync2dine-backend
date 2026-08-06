/**
 * Code-level smoke for Cynthia / Sally phone tools / Judie brain selection.
 * Not a live Vapi or OpenAI call — see ENGINEERING_AUDIT_REPORT validation notes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrainId } from './brains/index';
import { getToolsForMode } from './ai/orchestrator/tools-for-mode';
import { resolveMode } from './ai/orchestrator/helpers';
import { executePhoneTool } from './phone/tools/execute';
import type { OrchestratorRequest } from './ai/orchestrator-types';
import { isSallyToolName } from './sally/tools';
import { formatOfferFactsBlock, formatObjectionPlaybook } from './sally/offer';
import { buildOfferTermsPayload } from './phone/sally-sales-phone';
import { ATMOSPHERE_APPROVED_TALKING_POINTS } from './sally-product-kb/atmosphere-talking-points';

describe('agent smoke (code-level)', () => {
  it('Cynthia staff mode exposes orchestrator tools', () => {
    const body = {
      messages: [{ role: 'user', content: 'hello' }],
      mode: 'staff',
    } as OrchestratorRequest;
    const mode = resolveMode(body);
    const tools = getToolsForMode(mode, body);
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length > 0, 'staff mode should register tools');
  });

  it('Judie is the default diner brain; Cynthia only on purpose/persona', () => {
    assert.equal(resolveBrainId({}), 'judie');
    assert.equal(resolveBrainId({ callMeta: { linePurpose: 'aria' } }), 'judie');
    assert.equal(resolveBrainId({ agentPersona: 'cynthia' }), 'cynthia');
    assert.equal(
      resolveBrainId({
        callMeta: { aim: 'sales_outreach' },
        agentPersona: 'sally',
      }),
      'sally',
    );
  });

  it('Sally phone tool executor handles classifyCallIntent', async () => {
    const body: OrchestratorRequest = {
      messages: [],
      callContext: { callId: 'smoke_call_1', from: '+447700900123' },
    };
    const result = await executePhoneTool(
      'classifyCallIntent',
      { intent: 'general', confidence: 0.9, reason: 'smoke' },
      body,
    );
    assert.equal(result.intent, 'general');
    assert.ok(isSallyToolName('bookCallback'));
    assert.match(formatOfferFactsBlock(), /OFFER FACTS|Judie|Atmosphere/i);
  });

  it('Atmosphere offer facts discover beyond footfall and keep pricing guardrails', () => {
    const facts = formatOfferFactsBlock();
    assert.match(facts, /footfall vs in-venue spend|training\/motivation|Discover first/i);
    assert.match(facts, /139\/wk launch/);
    assert.match(facts, /208\/wk launch/);
    assert.match(facts, /proven track record helping venues increase sales/i);
    assert.match(facts, /never invent ROI/i);
    assert.match(facts, /cite as evidence/i);
    const objections = formatObjectionPlaybook();
    assert.match(objections, /not a music stream|exclusive brand soundtrack/i);
    assert.match(objections, /do not invent ROI/i);
  });

  it('getOfferTerms Atmosphere USPs cover exclusive music, zones, training, and track record', () => {
    const payload = buildOfferTermsPayload();
    const usps = (payload.usps as { atmosphere?: string[] }).atmosphere || [];
    const joined = usps.join('\n');
    assert.match(joined, /Exclusive soundtrack|keywords/i);
    assert.match(joined, /seating|kitchen/i);
    assert.match(joined, /announcements/i);
    assert.match(joined, /multi(?:ple)? weeks|training modules/i);
    assert.match(joined, /proven track record/i);
    assert.match(joined, /never invent ROI/i);
    assert.ok(ATMOSPHERE_APPROVED_TALKING_POINTS.length >= 5);
    assert.ok(ATMOSPHERE_APPROVED_TALKING_POINTS.every((p) => !/\d+\s*\/wk/.test(p.body)));
  });
});
