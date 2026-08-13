import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assistantSpeechTurns,
  combineVoiceReady,
  isSilentOutboundCall,
  nextSilentStreak,
} from './outbound-voice-health.js';
import { buildCampaignProgress } from './campaign-progress.js';
import { parseCampaignCsv } from '../outbound-campaigns.js';

describe('outbound voice health', () => {
  it('blocks dial when Vapi production or connection fails', () => {
    assert.equal(
      combineVoiceReady({ ok: false, errors: ['VAPI_PRIVATE_KEY is not configured'] }, { ok: true, message: 'ok' }).ok,
      false,
    );
    assert.equal(
      combineVoiceReady({ ok: true, errors: [] }, { ok: false, message: 'Vapi API error 401' }).ok,
      false,
    );
    assert.equal(combineVoiceReady({ ok: true, errors: [] }, { ok: true, message: 'ok' }).ok, true);
  });

  it('counts agent speech turns', () => {
    assert.equal(assistantSpeechTurns([{ role: 'agent', content: 'Hi, Sally here' }, { role: 'caller', content: 'Hello' }]), 1);
    assert.equal(assistantSpeechTurns([{ role: 'caller', content: 'Hello?' }]), 0);
    assert.equal(assistantSpeechTurns(null), 0);
  });

  it('does not treat no-answer as silent voice failure', () => {
    assert.equal(isSilentOutboundCall({
      direction: 'outbound',
      endedReason: 'customer-did-not-answer',
      durationSec: 25,
      transcript: [],
    }), false);
  });

  it('flags silence-timed-out outbound with no agent speech', () => {
    assert.equal(isSilentOutboundCall({
      direction: 'outbound',
      endedReason: 'silence-timed-out',
      durationSec: 40,
      transcript: [{ role: 'caller', content: '…' }],
    }), true);
  });

  it('flags long outbound with zero agent turns', () => {
    assert.equal(isSilentOutboundCall({
      direction: 'outbound',
      endedReason: 'hangup',
      durationSec: 12,
      transcript: [],
    }), true);
  });

  it('pauses after two consecutive silent calls', () => {
    const first = nextSilentStreak(0, true);
    assert.equal(first.consecutive, 1);
    assert.equal(first.shouldPause, false);
    const second = nextSilentStreak(1, true);
    assert.equal(second.shouldPause, true);
    const reset = nextSilentStreak(2, false);
    assert.equal(reset.consecutive, 0);
    assert.equal(reset.shouldPause, false);
  });
});

describe('campaign progress assembler', () => {
  it('counts queue statuses and dispositions for a batch', () => {
    const report = buildCampaignProgress({ batchId: 'sales-test-batch' }, {
      customers: [
        {
          id: 'C1',
          name: 'The Chippy',
          phone: '+447700900001',
          source: 'sales_csv_dial',
          leadBatchId: 'sales-test-batch',
          callQueueStatus: 'called',
          lastCallDisposition: 'answered_interested',
        },
        {
          id: 'C2',
          name: 'Curry House',
          phone: '+447700900002',
          source: 'csv_upload',
          campaign: 'sales-test-batch',
          callQueueStatus: 'queued',
        },
        {
          id: 'C3',
          name: 'Other',
          phone: '+447700900099',
          source: 'facebook',
          callQueueStatus: 'called',
        },
      ],
      outboundQueue: [
        { id: 'j1', status: 'queued', context: { batchId: 'sales-test-batch' }, to: '+447700900002' },
        { id: 'j2', status: 'needs_hours', context: { campaignId: 'sales-test-batch' }, to: '+447700900003' },
      ],
      calls: [
        {
          id: 'call1',
          direction: 'outbound',
          status: 'completed',
          customerId: 'C1',
          to: '+447700900001',
          contactName: 'The Chippy',
          outcome: 'answered_interested',
          startedAt: new Date().toISOString(),
          transcript: [
            { role: 'agent', content: 'Hi, it is Sally from Sync2Dine' },
            { role: 'caller', content: 'Go on then' },
          ],
        },
      ],
    });
    const leads = report.leads as { total: number; statuses: Record<string, number>; dispositions: Record<string, number> };
    assert.equal(leads.total, 2);
    assert.equal(leads.statuses.called, 1);
    assert.equal(leads.statuses.queued, 1);
    assert.equal(leads.dispositions.answered_interested, 1);
    const jobs = report.jobs as { heldForHours: number };
    assert.equal(jobs.heldForHours, 1);
    const spoken = String(report.spokenHint || '');
    assert.match(spoken, /sales-test-batch/);
    assert.match(spoken, /2 leads/);
    const recent = report.recentSaid as Array<{ snippet: string }>;
    assert.ok(recent.some((r) => /Sally from Sync2Dine/i.test(r.snippet)));
  });
});

describe('campaign CSV parse', () => {
  it('captures address for research hint', () => {
    const rows = parseCampaignCsv('company_name,phone,address,city\nThe Chippy,07700900123,1 High St,Birmingham\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'The Chippy');
    assert.match(String(rows[0].address || ''), /High St/);
  });
});
