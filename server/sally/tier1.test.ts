import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { heuristicTrustScores, formatTrustPromptBlock } from '../sally/trust-engine.js';
import { normalizeVenueType, suggestDialWindows, parseOpeningHoursHint } from '../sally/dial-windows.js';
import { draftSallyFollowThrough } from '../sally/follow-through.js';

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

  it('normalizeVenueType', () => {
    assert.equal(normalizeVenueType('Fish & Chip Takeaway'), 'takeaway');
    assert.equal(normalizeVenueType('The Red Lion Pub'), 'pub');
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
