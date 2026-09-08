import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isSallySalesCall,
  getSallyPhoneSessionChatTools,
  getOwnerHiringOpsTools,
  buildSallyBrainPrompt,
} from '../phone/sally-sales-phone.js';
import { isSallySalesCall as isSallySalesCallOffer } from './offer.js';
import {
  computeOverallScore,
  heuristicHireScoreFromTranscript,
  isArrangeInterviewCall,
  isHiringOwnerPhone,
  isSallyRecruitmentCall,
  recruitmentFirstMessage,
  recruitmentVoicemailMessage,
  SCORE_INTERVIEW_TOOL,
} from './recruitment-interview.js';
import { parseCv, normaliseUkMobile } from './cv-parse.js';
import { sallyBrain } from '../brains/sally/index.js';
import type { PhoneCallerIdentity } from '../phone/phone-auth.js';
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

describe('CV intake parsing', () => {
  it('pulls name, UK mobile, email and location out of CV text', () => {
    const parsed = parseCv(
      Buffer.from('Jane Smith\nWoking, UK | 07700 900123 | jane.smith@example.com\nSales rep at ACME'),
      'Jane-Smith-CV.txt',
    );
    assert.equal(parsed.name, 'Jane Smith');
    assert.equal(parsed.phone, '+447700900123');
    assert.equal(parsed.email, 'jane.smith@example.com');
    assert.equal(parsed.location, 'Woking, UK');
    assert.match(parsed.summary, /Sales rep at ACME/);
  });

  it('falls back to the filename when the CV has no readable name', () => {
    const parsed = parseCv(Buffer.from('experienced closer, target driven'), 'CVDarshanPanchal.pdf');
    assert.equal(parsed.name, 'Darshan Panchal');
    assert.equal(parsed.phone, undefined);
  });

  it('only treats UK mobiles as dialable', () => {
    assert.equal(normaliseUkMobile('07700900123'), '+447700900123');
    assert.equal(normaliseUkMobile('+44 7700 900123'), '+447700900123');
    assert.equal(normaliseUkMobile('020 3745 3233'), '');
  });
});

describe('hiring prompt and tools', () => {
  it('hiring tools are scoreInterview + candidate notes + bookInterview + endCall only', () => {
    const tools = getSallyPhoneSessionChatTools({ aim: 'recruitment_interview' });
    const names = tools.map((t) => t.function.name).sort();
    assert.deepEqual(
      names,
      ['bookInterview', 'endCall', 'logCandidate', 'scoreInterview', 'screenCandidate'].sort(),
    );
    assert.equal(SCORE_INTERVIEW_TOOL.function.name, 'scoreInterview');
    assert.ok(!names.includes('captureLead'));
  });

  it('note tools can persist the CV walkthrough and field comfort', () => {
    const tools = getSallyPhoneSessionChatTools({ aim: 'recruitment_interview' });
    const screen = tools.find((t) => t.function.name === 'screenCandidate');
    const props = Object.keys(
      (screen?.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties || {},
    );
    for (const field of ['experience', 'fieldComfort', 'rightToWork', 'notice', 'salaryExpectation', 'travelOk']) {
      assert.ok(props.includes(field), `screenCandidate should accept ${field}`);
    }
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
      outboundBrief: 'Sales applicant',
      callMeta: { aim: 'recruitment_interview', cvSummary: 'SDR with targets' },
    });
    assert.match(instructions, /job interview/i);
    assert.match(instructions, /scoreInterview/);
    assert.doesNotMatch(instructions, /GATEKEEPER PLAY/);
    assert.doesNotMatch(instructions, /is the manager or owner about/i);
  });

  it('hiring prompt is an HR briefing: Atmosphere only, no Judie, no numbered flow', () => {
    const { instructions } = buildSallyBrainPrompt({
      partyPhone: '+447484722571',
      direction: 'outbound',
      contactName: 'Joshua',
      callMeta: { aim: 'recruitment_interview', cvSummary: 'SDR with targets' },
    });
    assert.match(instructions, /Atmosphere/);
    assert.doesNotMatch(instructions, /Judie/);
    assert.doesNotMatch(instructions, /INTERVIEW FLOW/);
    assert.doesNotMatch(instructions, /^\s*1\)/m);
    // Field sales then office follow-up, and the CV walkthrough
    assert.match(instructions, /take the owner’s details/i);
    assert.match(instructions, /from the office/i);
    assert.match(instructions, /CV role by role/i);
    // High pay, no figures
    assert.match(instructions, /highly rewarding/i);
    assert.match(instructions, /NEVER quote a salary/);
    // No actual money figures anywhere in the brief
    assert.doesNotMatch(instructions, /£\s?\d|\b\d+\s?k\b|\b\d+\s?%/i);
    // Sally books the Woking face-to-face herself
    assert.match(instructions, /Woking/i);
    assert.match(instructions, /bookInterview/);
    assert.match(instructions, /Never tell anyone that a senior/i);
  });

  it('hire recommendation requires outbound comfort of 4 or 5', () => {
    const { instructions } = buildSallyBrainPrompt({
      partyPhone: '+447484722571',
      direction: 'outbound',
      callMeta: { aim: 'recruitment_interview' },
    });
    assert.match(instructions, /outboundComfort 4 or 5/);
  });

  it('arrange-interview callback only books the face-to-face', () => {
    const { instructions } = buildSallyBrainPrompt({
      partyPhone: '+447484722571',
      direction: 'outbound',
      callMeta: { aim: 'recruitment_interview', arrangeInterview: true },
    });
    assert.match(instructions, /ONE JOB/);
    assert.match(instructions, /Do not re-interview/i);
    assert.equal(isArrangeInterviewCall({ arrangeInterview: true }), true);
    assert.equal(isArrangeInterviewCall({ aim: 'recruitment_interview' }), false);
  });

  it('first messages and voicemail are hiring not restaurant sales', () => {
    assert.match(
      recruitmentFirstMessage({ firstName: 'Joshua', direction: 'outbound' }),
      /applied for our restaurant sales role/,
    );
    assert.match(
      recruitmentFirstMessage({ firstName: 'Joshua', direction: 'inbound' }),
      /ringing back about the sales role/,
    );
    assert.match(
      recruitmentFirstMessage({ firstName: 'Joshua', direction: 'outbound', arrangeInterviewOnly: true }),
      /come in and meet us/,
    );
    assert.doesNotMatch(
      recruitmentFirstMessage({ firstName: 'Joshua', direction: 'outbound', founderTest: true }),
      /Judie/,
    );
    const vm = recruitmentVoicemailMessage();
    assert.match(vm, /sales role you applied for/);
    assert.doesNotMatch(vm, /orders/);
    assert.doesNotMatch(vm, /Cynthia|Builder Diddies/i);
  });

  it('owner line gets hiring ops, not a candidate interview or a restaurant pitch', () => {
    assert.equal(isHiringOwnerPhone('+447576442345'), true);
    assert.equal(isHiringOwnerPhone('07576 442345'), true);
    assert.equal(isHiringOwnerPhone('+447484722571'), false);

    const { instructions } = buildSallyBrainPrompt({
      partyPhone: '+447576442345',
      direction: 'inbound',
      staffMode: true,
      ownerHiringOps: true,
      phoneAuthVerified: false,
      callMeta: {},
    });
    assert.match(instructions, /OWNER HIRING OPS/);
    assert.match(instructions, /setHiringInstruction/);
    assert.match(instructions, /queueRecruitmentCall/);
    assert.match(instructions, /never from his mobile/i);
    assert.match(instructions, /do NOT read out candidate notes/i);
    assert.doesNotMatch(instructions, /THIS IS A JOB INTERVIEW/);

    const unverified = getOwnerHiringOpsTools({ verified: false }).map((t) => t.function.name);
    assert.deepEqual(unverified.sort(), ['queueRecruitmentCall', 'setHiringInstruction']);
    const verified = getOwnerHiringOpsTools({ verified: true }).map((t) => t.function.name);
    assert.ok(verified.includes('bookInterview'));
    assert.ok(verified.includes('logCandidate'));
  });

  it('inbound from the founder mobile builds owner ops even when tagged recruitment_interview', async () => {
    const session = await sallyBrain.buildSession({
      partyPhone: '+447576442345',
      direction: 'inbound',
      identity: {
        kind: 'customer',
        route: { mode: 'guest' } as unknown as PhoneCallerIdentity['route'],
        role: 'customer',
        name: 'Guest',
        phone: '+447576442345',
        userId: null,
        pinConfigured: false,
        needsPin: false,
      },
      verified: false,
      callMeta: { aim: 'recruitment_interview', agentPersona: 'sally' },
    });
    assert.match(session.instructions, /OWNER HIRING OPS/);
    assert.doesNotMatch(session.instructions, /THIS IS A JOB INTERVIEW/);
    assert.match(session.firstMessage, /hiring/i);
    const names = session.chatTools.map((t) => t.function.name);
    assert.ok(names.includes('setHiringInstruction'));
    assert.ok(names.includes('queueRecruitmentCall'));
    assert.ok(names.includes('verifyStaffPhonePin'));
    assert.ok(!names.includes('scoreInterview'));
  });

  it('recruitment silence reask does not ask for manager', () => {
    const hooks = buildSilenceHooks('sally', { recruitment: true });
    const reask = hooks.find((h) => h.name === 'silence_reask') as { do?: Array<{ exact?: string }> };
    const text = String(reask?.do?.[0]?.exact || '');
    assert.match(text, /finish the interview/i);
    assert.doesNotMatch(text, /manager or owner/i);
  });
});
