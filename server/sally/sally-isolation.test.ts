/**
 * Isolation guards: Sally Sync2Gear company-phone retarget must not affect
 * Judie diner, Cynthia, home-org tenant brand, or food-order tools.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BDIDDIES_COMPANY } from '../home-org.js';
import { BUILDER_DIDDIES_COMPANY, brandPhonePromptAsCynthia } from '../brains/cynthia/branding.js';
import { resolveBrainId } from '../brains/index.js';
import { judieBrain } from '../brains/judie/index.js';
import { sallyBrain } from '../brains/sally/index.js';
import { getJudieDinerChatTools } from '../phone/phone-brain.js';
import { getSallyPhoneSessionChatTools } from '../phone/sally-sales-phone.js';
import { buildVoiceBrandReplacements } from '../phone/vapi-assistant.js';
import {
  SALLY_EMPLOYER,
  SALLY_EMPLOYER_SPOKEN,
  SALLY_EMPLOYER_TTS,
  SALLY_SYNC2GEAR_SELL_FACTS,
} from './brand.js';
import type { PhoneCallerIdentity } from '../phone/phone-auth.js';

function guestIdentity(phone = '+441234567890'): PhoneCallerIdentity {
  return {
    kind: 'customer',
    route: { mode: 'guest' } as PhoneCallerIdentity['route'],
    role: 'customer',
    name: '',
    phone,
    userId: null,
    pinConfigured: false,
    needsPin: false,
  };
}

describe('Sally dual-brand isolation', () => {
  it('does not mutate home-org Sync2Dine tenant brand', () => {
    assert.equal(BDIDDIES_COMPANY.companyName, 'Sync2Dine');
    assert.equal(BDIDDIES_COMPANY.spokenCompanyName, 'sync Two dine');
    assert.notEqual(SALLY_EMPLOYER, BDIDDIES_COMPANY.companyName);
  });

  it('locks Sync2Gear/FloorMix sell facts', () => {
    assert.ok(SALLY_SYNC2GEAR_SELL_FACTS.length >= 5);
    assert.ok(SALLY_SYNC2GEAR_SELL_FACTS.some((l) => /FloorMix/i.test(l)));
    assert.ok(SALLY_SYNC2GEAR_SELL_FACTS.some((l) => /Sync2Dine/i.test(l)));
  });

  it('Sally inbound is Sync2Gear company receptionist', async () => {
    const session = await sallyBrain.buildSession({
      partyPhone: '+441234567890',
      direction: 'inbound',
      identity: guestIdentity(),
      verified: false,
    });
    assert.match(session.firstMessage, new RegExp(SALLY_EMPLOYER_SPOKEN.replace(/\s+/g, '\\s+')));
    assert.match(session.instructions, /company receptionist|company line|Sync2Gear/i);
    assert.match(session.instructions, /FloorMix/i);
    assert.doesNotMatch(session.firstMessage, /hiring/i);
  });

  it('Judie diner session has no Sync2Gear receptionist copy', async () => {
    const session = await judieBrain.buildSession({
      partyPhone: '+441234567890',
      direction: 'inbound',
      identity: guestIdentity(),
      verified: false,
      orgId: 'org_isolation_judie',
    });
    assert.doesNotMatch(session.instructions, /Sync2Gear company receptionist/i);
    assert.doesNotMatch(session.instructions, /FloorMix/i);
    assert.doesNotMatch(session.firstMessage || '', /sync Two gear/i);
  });

  it('Cynthia Builder Diddies branding unchanged', () => {
    assert.equal(BUILDER_DIDDIES_COMPANY.companyName, 'Builder Diddies');
    assert.equal(BUILDER_DIDDIES_COMPANY.assistantName, 'Cynthia');
    const branded = brandPhonePromptAsCynthia('Hello from Sync2Dine and Judie');
    assert.match(branded, /Builder Diddies/);
    assert.match(branded, /Cynthia/);
    assert.doesNotMatch(branded, /Sync2Gear/);
  });

  it('TTS Sync2Gear maps only for Sally; Sync2Dine maps always', () => {
    const judie = buildVoiceBrandReplacements(false);
    const sally = buildVoiceBrandReplacements(true);
    assert.ok(judie.some((r) => r.key === 'Sync2Dine' && r.value === 'Sync to Dine'));
    assert.ok(!judie.some((r) => r.key === 'Sync2Gear'));
    assert.ok(sally.some((r) => r.key === 'Sync2Gear' && r.value === SALLY_EMPLOYER_TTS));
    assert.ok(sally.some((r) => r.key === SALLY_EMPLOYER_SPOKEN));
  });

  it('Judie diner tools still include placeFoodOrder; Sally sales exclude it', () => {
    const judieNames = getJudieDinerChatTools().map((t) => t.function.name);
    const sallyNames = getSallyPhoneSessionChatTools({ aim: 'sales_outreach' }).map((t) => t.function.name);
    assert.ok(judieNames.includes('placeFoodOrder'));
    assert.ok(!sallyNames.includes('placeFoodOrder'));
  });

  it('aria linePurpose still resolves to judie', () => {
    assert.equal(
      resolveBrainId({ agentPersona: 'judie', callMeta: { linePurpose: 'aria' } }),
      'judie',
    );
  });
});
