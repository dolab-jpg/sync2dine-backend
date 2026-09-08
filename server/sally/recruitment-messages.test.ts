import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saveRecruitmentCandidate } from '../data-store.js';
import {
  appendRecruitmentMessage,
  listRecruitmentMessages,
  listRecruitmentSnapshot,
} from './recruitment-messages.js';

describe('recruitment messages', () => {
  it('appends in/out Indeed messages onto the candidate, not CRM customers', () => {
    saveRecruitmentCandidate({
      id: 'cand-msg-test',
      name: 'Test Applicant',
      phone: '+447700900111',
      source: 'indeed',
    });
    const out = appendRecruitmentMessage({
      candidateId: 'cand-msg-test',
      direction: 'out',
      channel: 'indeed',
      body: 'Thanks for applying — when can you talk?',
      fromLabel: 'Sally / recruitment',
    });
    const inn = appendRecruitmentMessage({
      phone: '+447700900111',
      direction: 'in',
      channel: 'indeed',
      body: 'I can do Thursday afternoon.',
    });
    const thread = listRecruitmentMessages('cand-msg-test');
    assert.equal(out.direction, 'out');
    assert.equal(inn.direction, 'in');
    assert.equal(inn.channel, 'indeed');
    assert.equal(thread.length >= 2, true);
    assert.equal(thread.at(-1)?.body, 'I can do Thursday afternoon.');
    const snap = listRecruitmentSnapshot();
    const cand = snap.candidates.find((c) => String(c.id) === 'cand-msg-test');
    assert.ok(cand);
    assert.ok(Array.isArray(cand.messages));
  });

  it('dedupes the same externalId + body', () => {
    saveRecruitmentCandidate({ id: 'cand-msg-dup', name: 'Dup', phone: '+447700900222' });
    const a = appendRecruitmentMessage({
      candidateId: 'cand-msg-dup',
      body: 'Hello',
      channel: 'indeed',
      direction: 'in',
      externalId: 'indeed-1',
    });
    const b = appendRecruitmentMessage({
      candidateId: 'cand-msg-dup',
      body: 'Hello',
      channel: 'indeed',
      direction: 'in',
      externalId: 'indeed-1',
    });
    assert.equal(a.id, b.id);
    assert.equal(listRecruitmentMessages('cand-msg-dup').filter((m) => m.body === 'Hello').length, 1);
  });
});
