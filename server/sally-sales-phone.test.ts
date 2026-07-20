import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  phoneDigitsForMatch,
  isSallyInboundLine,
  isSallySalesCall,
  isSallyTransferAllowed,
  listSallyInboundNumbers,
  resolveSallyWebsiteUrl,
  getSallyPhoneSessionChatTools,
  buildOfferTermsPayload,
  SALLY_PERSONA,
} from './sally-sales-phone';

describe('Sally inbound line matching', () => {
  const prev = {
    SALLY_DEMO_PHONE: process.env.SALLY_DEMO_PHONE,
    TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
    TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
    SALLY_INBOUND_NUMBERS: process.env.SALLY_INBOUND_NUMBERS,
    SALLY_WEBSITE_URL: process.env.SALLY_WEBSITE_URL,
    APP_BASE_URL: process.env.APP_BASE_URL,
    SALLY_ALLOW_TRANSFER: process.env.SALLY_ALLOW_TRANSFER,
  };

  before(() => {
    process.env.SALLY_DEMO_PHONE = '02080505029';
    process.env.TWILIO_FROM_NUMBER = '+447700900123';
    process.env.SALLY_INBOUND_NUMBERS = '+442037453233, 02037459999';
    delete process.env.TWILIO_PHONE_NUMBER;
    delete process.env.SALLY_ALLOW_TRANSFER;
  });

  after(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('normalizes UK / E.164 digits for compare', () => {
    assert.equal(phoneDigitsForMatch('+44 208 050 5029'), '2080505029');
    assert.equal(phoneDigitsForMatch('02080505029'), '2080505029');
    assert.equal(phoneDigitsForMatch('442080505029'), '2080505029');
  });

  it('matches demo, Twilio From, and allowlist numbers exactly', () => {
    assert.equal(isSallyInboundLine('+442080505029'), true);
    assert.equal(isSallyInboundLine('02080505029'), true);
    assert.equal(isSallyInboundLine('+447700900123'), true);
    assert.equal(isSallyInboundLine('02037453233'), true);
    assert.equal(isSallyInboundLine('02037459999'), true);
    assert.equal(isSallyInboundLine('+441234567890'), false);
  });

  it('rejects short fragments and endsWith false-positives', () => {
    assert.equal(isSallyInboundLine('8050502'), false);
    assert.equal(isSallyInboundLine('80505029'), false);
    // Unrelated number that merely shares a suffix must not match
    assert.equal(isSallyInboundLine('+4411180505029'), false);
  });

  it('listSallyInboundNumbers includes configured sources', () => {
    const list = listSallyInboundNumbers();
    assert.ok(list.some((n) => phoneDigitsForMatch(n) === '2080505029'));
    assert.ok(list.some((n) => phoneDigitsForMatch(n) === '7700900123'));
  });

  it('isSallySalesCall treats matching lineDid as Sally', () => {
    assert.equal(isSallySalesCall({}, { lineDid: '+442080505029' }), true);
    assert.equal(isSallySalesCall({ lineDid: '+447700900123' }), true);
    assert.equal(isSallySalesCall({ agentPersona: SALLY_PERSONA }), true);
    assert.equal(isSallySalesCall({ aim: 'sales_outreach' }), true);
    assert.equal(isSallySalesCall({}, { lineDid: '+441111111111' }), false);
  });

  it('resolveSallyWebsiteUrl prefers SALLY_WEBSITE_URL', () => {
    process.env.SALLY_WEBSITE_URL = 'https://sync2dine.io/';
    assert.equal(resolveSallyWebsiteUrl(), 'https://sync2dine.io');
  });

  it('blocks Sally transfer by default', () => {
    delete process.env.SALLY_ALLOW_TRANSFER;
    assert.equal(isSallyTransferAllowed(), false);
    process.env.SALLY_ALLOW_TRANSFER = '1';
    assert.equal(isSallyTransferAllowed(), true);
    delete process.env.SALLY_ALLOW_TRANSFER;
  });

  it('Sally tools include safe transferToHuman description (not warm-dial copy)', () => {
    const tools = getSallyPhoneSessionChatTools();
    const xfer = tools.find((t) => t.function.name === 'transferToHuman');
    assert.ok(xfer);
    assert.match(String(xfer!.function.description), /AI-staffed|takeMessage|blocked/i);
    assert.doesNotMatch(String(xfer!.function.description), /Warm-transfer the live call/);
  });

  it('offer payload exposes demo phone for SMS/callback alignment', () => {
    const offer = buildOfferTermsPayload();
    assert.ok(String(offer.demoPhone || '').length > 0);
    assert.ok(String(offer.spokenDemoPhone || '').length > 0);
  });
});
