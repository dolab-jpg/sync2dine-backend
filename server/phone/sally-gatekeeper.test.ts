/**
 * Sally gatekeeper / manager-handoff regression tests.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhoneCallerIdentity } from './phone-auth.js';
import { getDataStore, saveCustomerRecord, withOrgContext } from '../data-store.js';
import { sallyBrain } from '../brains/sally/index.js';
import { SALES_CAPTURE_LEAD_TOOL } from './tools/catalog.js';
import {
  buildSallyBrainPrompt,
  getSallyPhoneSessionChatTools,
} from './sally-sales-phone.js';
import { buildSilenceHooks } from './vapi-assistant.js';
import {
  mapEndedReasonToDisposition,
  queueStatusAfterDisposition,
} from './lead-call-disposition.js';
import { captureReferralAndQueue } from '../sally/schedule-outbound.js';
import { formatPhoneOfferFactsBlock, formatOfferFactsBlock } from '../sally/offer.js';

const TEST_ORG = 'org_sally_gatekeeper_test';
const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', `synced-data-${TEST_ORG}.json`);

function run<T>(fn: () => T): T {
  return withOrgContext(TEST_ORG, fn);
}

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

describe('Sally gatekeeper phone flow', () => {
  after(() => {
    try {
      if (existsSync(DATA_FILE)) unlinkSync(DATA_FILE);
    } catch {
      /* ignore */
    }
  });

  it('captureLead sales schema requires only venue name (contactName optional)', () => {
    const required = SALES_CAPTURE_LEAD_TOOL.function.parameters.required as string[];
    assert.deepEqual(required, ['name']);
    assert.match(SALES_CAPTURE_LEAD_TOOL.function.description, /never invent/i);
    assert.doesNotMatch(SALES_CAPTURE_LEAD_TOOL.function.description, /Always pass both/i);
  });

  it('captureReferralAndQueue schema requires phone only', () => {
    const tool = getSallyPhoneSessionChatTools().find((t) => t.function.name === 'captureReferralAndQueue');
    assert.ok(tool);
    assert.deepEqual(tool!.function.parameters.required, ['phone']);
  });

  it('outbound unknown-contact opener asks for manager, not name', async () => {
    const session = await sallyBrain.buildSession({
      partyPhone: '+441234567890',
      direction: 'outbound',
      identity: guestIdentity('+441234567890'),
      verified: false,
      contactName: '',
      callMeta: { source: 'csv_campaign', aim: 'sales_outreach' },
    });
    assert.match(session.firstMessage, /manager or owner/i);
    assert.doesNotMatch(session.firstMessage, /who am I speaking with/i);
  });

  it('referral outbound opener mentions who referred Sally', async () => {
    const session = await sallyBrain.buildSession({
      partyPhone: '+447700900222',
      direction: 'outbound',
      identity: guestIdentity('+447700900222'),
      verified: false,
      contactName: '',
      outboundBrief: 'REFERRAL: We spoke to Ali on the main line',
      callMeta: {
        source: 'gatekeeper_referral',
        referredByName: 'Ali',
        aim: 'sales_outreach',
      },
    });
    assert.match(session.firstMessage, /Ali/i);
    assert.doesNotMatch(session.firstMessage, /who am I speaking with/i);
  });

  it('brain prompt includes gatekeeper play, AI own-it, and runtime priorities; no name demand', () => {
    const { instructions } = buildSallyBrainPrompt({
      partyPhone: '+441234567890',
      direction: 'outbound',
      contactName: '',
    });
    assert.match(instructions, /GATEKEEPER PLAY/i);
    assert.match(instructions, /SALLY PHONE RUNTIME PRIORITIES/i);
    assert.match(instructions, /I'm actually what's for sale|what's for sale/i);
    assert.match(instructions, /do NOT push the answerer for their name/i);
    assert.doesNotMatch(instructions, /ask who you are speaking with when it fits/i);
    assert.match(instructions, /Close path \(PHONE\)/i);
    assert.doesNotMatch(instructions, /createSaasContract ? sendContract ? after signed ? sendStripeCheckoutLink/);
  });

  it('phone offer facts omit web contract close; web facts keep it', () => {
    const phone = formatPhoneOfferFactsBlock();
    const web = formatOfferFactsBlock();
    assert.match(phone, /Close path \(PHONE\)/);
    assert.match(phone, /Do NOT run createSaasContract/);
    assert.match(web, /sendStripeCheckoutLink/);
    assert.doesNotMatch(web, /Close path \(PHONE\)/);
  });

  it('silence re-ask is manager-seeking, not meeting yes/no', () => {
    const hooks = buildSilenceHooks('sally', { omitHangup: true, timeoutScale: 2.5 });
    const reask = hooks.find((h) => h.name === 'silence_reask') as {
      do?: Array<{ exact?: string }>;
    };
    const text = String(reask?.do?.[0]?.exact || '');
    assert.match(text, /manager or owner/i);
    assert.doesNotMatch(text, /twenty-minute install chat/i);
  });

  it('gatekeeper_manager_callback maps to called (never needs_retry)', () => {
    assert.equal(
      mapEndedReasonToDisposition('assistant-ended-call', {
        toolOutcome: 'gatekeeper_manager_callback',
      }),
      'gatekeeper_manager_callback',
    );
    assert.equal(queueStatusAfterDisposition('gatekeeper_manager_callback', 1), 'called');
    assert.equal(queueStatusAfterDisposition('gatekeeper_manager_callback', 0), 'called');
  });

  it('phone-only manager referral queues without inventing a name and stamps disposition', () => {
    run(() => {
      const venue = saveCustomerRecord({
        name: 'Chutney Jacks',
        phone: '+441296715055',
        status: 'lead',
      });
      const result = captureReferralAndQueue({
        phone: '+447700900333',
        role: 'manager',
        referredByCustomerId: String(venue.id),
        referredByVenue: 'Chutney Jacks',
        referredByPhone: '+441296715055',
        callId: 'out-gatekeeper-test-1',
        summary: 'Gatekeeper said manager is out until 4pm',
        preferredContactTimes: 'weekdays after 4pm',
      });
      assert.equal(result.ok, true);
      assert.equal(result.isNewLead, false);
      const store = getDataStore();
      const row = store.customers.find((c) => String(c.id) === String(venue.id)) as Record<string, unknown>;
      assert.ok(row);
      assert.equal(String(row.phone), '+441296715055');
      const referral = row.referral as Record<string, unknown>;
      assert.ok(referral?.pendingCallback);
      const pending = referral.pendingCallback as Record<string, unknown>;
      assert.equal(String(pending.phone).includes('7700900333') || String(pending.phone).includes('+447700900333'), true);
      assert.equal(row.preferredContactTimes, 'weekdays after 4pm');
      const call = store.calls.find((c) => String(c.id) === 'out-gatekeeper-test-1') as Record<string, unknown> | undefined;
      // Call row may be created by saveCall outcome stamp
      if (call) {
        assert.equal(String(call.outcome), 'gatekeeper_manager_callback');
      }
      assert.equal(String(row.lastCallDisposition || ''), 'gatekeeper_manager_callback');
    });
  });
});
