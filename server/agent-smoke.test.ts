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
import { formatOfferFactsBlock } from './sally/offer';

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
    assert.match(formatOfferFactsBlock(), /OFFER FACTS|Judie|Atmosphere|£/i);
  });
});
