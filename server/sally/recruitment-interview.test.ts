import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSallySalesCall, getSallyPhoneSessionChatTools, buildSallyBrainPrompt } from '../phone/sally-sales-phone.js';
import { isSallySalesCall as isSallySalesCallOffer } from './offer.js';
import {
  computeOverallScore,
  heuristicHireScoreFromTranscript,
  isSallyRecruitmentCall,
  recruitmentFirstMessage,
  recruitmentVoicemailMessage,
  SCORE_INTERVIEW_TOOL,
} from './recruitment-interview.js';
import { buildSilenceHooks } from '../phone/vapi-assistant.js';

describe('recruitment isolation', () => {
  it('isSallySalesCall is false for hiring even with Sally persona (phone + offer)', () => {
    const meta = { agentPersona: 'sally', aim: 'recruitment_interview' };
    assert.equal(isSallySalesCall(meta), false);
    assert.equal(isSallySalesCallOffer(meta), false);
  });

  it('csv campaign and gatekeeper referral stay sales', () => {
    assert.equal(isSallySalesCall({ source: 'csv_campaign', agentPersona: 'sally' }), true);
    assert.equal(isSallySalesCall({ source: 'gatekeeper_referral', aim: 'sales_outreach' }), true);
  });

  it('isSallyRecruitmentCall matches aim / source / candidate+recruitment', () => {
    assert.equal(isSallyRecruitmentCall({ aim: 'recruitment_interview' }), true);
    assert.equal(isSallyRecruitmentCall({ source: 'recruitment_interview' }), true);
    assert.equal(isSallyRecruitmentCall({ candidateId: 'CAND1', aim: 'recruitment' }), true);
    assert.equal(isSallyRecruitmentCall({ source: 'csv_campaign' }), false);
  });
});

describe('hire scorecard', () => {
  it('computeOverallScore uses 0.2/0.3/0.2/0.2/0.1 weights', () => {
    const overall = computeOverallScore({
      hunger: 5,
      salesProof: 5,
      restaurantFit: 5,
      outboundComfort: 5,
      cvHonesty: 5,
    });
    assert.equal(overall, 5);
    const mixed = computeOverallScore({
      hunger: 5,
      salesProof: 1,
      restaurantFit: 5,
      outboundComfort: 5,
      cvHonesty: 5,
    });
    assert.equal(mixed, 3.8);
  });

  it('heuristicHireScoreFromTranscript returns a card', () => {
    const card = heuristicHireScoreFromTranscript(
      'I closed 110 percent of target last quarter walking into restaurants and cold calling owners. I am hungry for this role.',
    );
    assert.ok(card.overall >= 1 && card.overall <= 5);
    assert.ok(['hire', 'maybe', 'no'].includes(card.recommendation));
    assert.ok(card.notes.length > 0);
  });
});

describe('hiring prompt and tools', () => {
  it('hiring tools are scoreInterview + candidate + endCall only', () => {
    const tools = getSallyPhoneSessionChatTools({ aim: 'recruitment_interview' });
    const names = tools.map((t) => t.function.name).sort();
    assert.deepEqual(names, ['endCall', 'logCandidate', 'scoreInterview', 'screenCandidate'].sort());
    assert.equal(SCORE_INTERVIEW_TOOL.function.name, 'scoreInterview');
  });

  it('sales tools still include captureLead and bookIntegrationMeeting', () => {
    const names = getSallyPhoneSessionChatTools({ source: 'csv_campaign', agentPersona: 'sally' })
      .map((t) => t.function.name);
    assert.ok(names.includes('captureLead'));
    assert.ok(names.includes('bookIntegrationMeeting'));
  });

  it('recruitment prompt never asks for manager or captureLead', () => {
    const { instructions } = buildSallyBrainPrompt({
      partyPhone: '+447484722571',
      direction: 'outbound',
      contactName: 'Joshua',
      outboundBrief: 'Indeed applicant',
      callMeta: { aim: 'recruitment_interview', cvSummary: 'SDR with targets' },
    });
    assert.match(instructions, /job interview/i);
    assert.match(instructions, /scoreInterview/);
    assert.doesNotMatch(instructions, /GATEKEEPER PLAY/);
    assert.doesNotMatch(instructions, /is the manager or owner about/i);
  });

  it('first messages and voicemail are hiring not restaurant sales', () => {
    assert.match(
      recruitmentFirstMessage({ firstName: 'Joshua', direction: 'outbound' }),
      /Indeed for a restaurant sales role/,
    );
    assert.match(
      recruitmentFirstMessage({ firstName: 'Joshua', direction: 'inbound' }),
      /ringing back about the sales role/,
    );
    const vm = recruitmentVoicemailMessage();
    assert.match(vm, /Indeed/);
    assert.doesNotMatch(vm, /orders/);
    assert.doesNotMatch(vm, /Cynthia|Builder Diddies/i);
  });

  it('recruitment silence reask does not ask for manager', () => {
    const hooks = buildSilenceHooks('sally', { recruitment: true });
    const reask = hooks.find((h) => h.name === 'silence_reask') as { do?: Array<{ exact?: string }> };
    const text = String(reask?.do?.[0]?.exact || '');
    assert.match(text, /finish the interview/i);
    assert.doesNotMatch(text, /manager or owner/i);
  });
});
