import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  heuristicTrustScores,
  formatTrustPromptBlock,
} from '../sally/trust-engine.js';
import {
  normalizeVenueType,
  suggestDialWindows,
  parseOpeningHoursHint,
  parseClosedDaysHint,
  normalizeWeeklyHours,
  nextEligibleCallAt,
  londonMinutesNow,
} from '../sally/dial-windows.js';
import {
  assessContactEligibility,
  formatReferralBrief,
  isDoNotCallCustomer,
} from '../sally/call-eligibility.js';
import { draftSallyFollowThrough } from '../sally/follow-through.js';
import { isSallySalesCall } from '../phone/sally-sales-phone.js';
import { normalizeDialableE164 } from '../phone/tools/leads.js';

describe('trust-engine', () => {
  it('marks trust down on DNC language', () => {
    const t = heuristicTrustScores({
      transcriptLower: 'please do not call again not interested',
      outcome: 'dnc',
      objections: ['not_interested'],
    });
    assert.equal(t.trustDelta, 'down');
    assert.equal(t.referralLikelihood, 'low');
  });

  it('formats prompt block without dialogue scripts', () => {
    const block = formatTrustPromptBlock(heuristicTrustScores({
      transcriptLower: 'cheers lovely meeting booked install',
      rapportScore: 4,
      outcome: 'meeting_booked',
    }));
    assert.match(block, /TRUST ENGINE/);
    assert.doesNotMatch(block, /say exactly/i);
  });
});

describe('dial-windows', () => {
  it('classifies takeaway and allows late quiet bypass', () => {
    const d = suggestDialWindows({
      venueType: 'takeaway',
      openingHours: '16:00-23:00',
      hasKitchen: true,
    });
    assert.equal(d.venueType, 'takeaway');
    assert.equal(d.bypassGlobalQuiet, true);
    assert.equal(d.pitchAngle, 'judie_phone');
    assert.ok(d.nextSlotISO);
  });

  it('no kitchen sets revenue angle', () => {
    const d = suggestDialWindows({ venueType: 'cafe', hasKitchen: false });
    assert.equal(d.pitchAngle, 'no_kitchen_revenue');
  });

  it('parses hours', () => {
    const h = parseOpeningHoursHint('Mon-Sun 12-23');
    assert.ok(h);
    assert.equal(h!.openHour, 12);
    assert.equal(h!.closeHour, 23);
  });

  it('parses closed days from free text', () => {
    const closed = parseClosedDaysHint('Tue-Sun 12-22 Closed Mon');
    assert.ok(closed.includes('mon'));
  });

  it('skips closed weekdays when computing next slot', () => {
    // Fixed from: Wednesday 2026-08-05 09:00 London-ish
    const from = new Date('2026-08-05T08:00:00.000Z');
    const weekly = normalizeWeeklyHours({
      mon: [],
      tue: [{ openHour: 12, closeHour: 22 }],
      wed: [{ openHour: 12, closeHour: 22 }],
      thu: [{ openHour: 12, closeHour: 22 }],
      fri: [{ openHour: 12, closeHour: 22 }],
      sat: [{ openHour: 12, closeHour: 22 }],
      sun: [{ openHour: 12, closeHour: 22 }],
    });
    assert.ok(weekly);
    const slot = nextEligibleCallAt({
      venueType: 'restaurant',
      weeklyHours: weekly!,
      closedDays: ['mon'],
      from,
      timezone: 'Europe/London',
    });
    assert.ok(slot);
    // Must not land on Monday
    const wd = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'short',
    }).format(new Date(slot!));
    assert.notEqual(wd.toLowerCase().slice(0, 3), 'mon');
  });

  it('prefers preferredContactTimes over venue defaults', () => {
    const d = suggestDialWindows({
      venueType: 'restaurant',
      openingHours: '09:00-22:00',
      preferredContactTimes: '14:00-15:00',
      from: new Date('2026-08-05T08:00:00.000Z'),
      timezone: 'Europe/London',
    });
    assert.ok(d.windows.some((w) => w.label.includes('preferred')));
    assert.ok(d.nextSlotISO);
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: 'numeric',
        hour12: false,
      }).format(new Date(d.nextSlotISO!)),
    );
    assert.ok(hour >= 14 && hour < 15);
  });

  it('normalizeVenueType', () => {
    assert.equal(normalizeVenueType('Fish & Chip Takeaway'), 'takeaway');
    assert.equal(normalizeVenueType('The Red Lion Pub'), 'pub');
  });

  it('londonMinutesNow returns finite minutes', () => {
    const m = londonMinutesNow(new Date('2026-08-05T12:30:00.000Z'), 'Europe/London');
    assert.ok(Number.isFinite(m));
    assert.ok(m >= 0 && m < 24 * 60);
  });
});

describe('call-eligibility', () => {
  it('blocks do-not-call customers', () => {
    assert.equal(isDoNotCallCustomer({ doNotCall: true }), true);
    const e = assessContactEligibility({ callQueueStatus: 'do_not_call' });
    assert.equal(e.eligible, false);
    assert.equal(e.reason, 'do_not_call');
  });

  it('blocks explicit consent decline', () => {
    const e = assessContactEligibility({ consentToCall: false });
    assert.equal(e.eligible, false);
    assert.equal(e.reason, 'consent_declined');
  });

  it('allows unknown consent by default', () => {
    const e = assessContactEligibility({ name: 'Test Kitchen' });
    assert.equal(e.eligible, true);
  });

  it('formats referral brief without inventing interest', () => {
    const brief = formatReferralBrief({
      referredByName: 'Sam',
      referredByPhone: '+447700900123',
      referredByVenue: 'Red Lion',
      summary: 'Asked about missed calls',
    });
    assert.match(brief, /Sam at Red Lion/);
    assert.match(brief, /Do not invent/);
    assert.match(brief, /missed calls/);
  });
});

describe('referral phone normalize', () => {
  it('normalizes UK mobile', () => {
    const n = normalizeDialableE164('07576442345');
    assert.ok(n);
    assert.match(n!, /^\+447576442345$/);
  });

  it('rejects names', () => {
    assert.equal(normalizeDialableE164('the boss'), null);
  });
});

describe('sally brain routing', () => {
  it('routes gatekeeper referral and csv campaign as Sally', () => {
    assert.equal(isSallySalesCall({ source: 'gatekeeper_referral', aim: 'sales_outreach' }), true);
    assert.equal(isSallySalesCall({ source: 'csv_campaign', agentPersona: 'sally' }), true);
    assert.equal(isSallySalesCall({ source: 'book_callback' }), true);
    assert.equal(isSallySalesCall({}), false);
  });
});

describe('follow-through', () => {
  it('drafts email for meet objective', () => {
    const d = draftSallyFollowThrough({
      venueName: 'Test Kitchen',
      contactName: 'Sam',
      callObjective: 'meet',
    });
    assert.match(d.emailSubject, /install meeting/i);
    assert.match(d.crmTask, /objective=meet/);
  });
});
