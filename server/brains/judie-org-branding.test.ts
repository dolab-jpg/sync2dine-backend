/**
 * Judie diner branding must follow DID-resolved org  not home / Sync2Dine.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createOrganization, deleteOrganization, listOrganizations } from '../organizations';
import { withOrgContext, updateAgentSettings } from '../data-store';
import { buildBrainSession } from './index';
import type { PhoneCallerIdentity } from '../phone/phone-auth';
import type { ChannelRoute } from '../channel-router';

function dinerIdentity(phone = '+447700900111'): PhoneCallerIdentity {
  const route = {
    mode: 'customer',
    preferredLanguage: 'en',
  } as ChannelRoute;
  return {
    kind: 'customer',
    route,
    role: 'customer',
    name: 'Guest',
    phone,
    userId: null,
    pinConfigured: false,
    needsPin: false,
  };
}

describe('Judie per-org branding', () => {
  let orgA = '';
  let orgB = '';
  const createdOrgIds: string[] = [];

  before(() => {
    listOrganizations();
    const a = createOrganization({
      name: 'Curry Palace Branding A',
      contactName: 'A',
      contactEmail: `judie-brand-a-${Date.now()}@example.com`,
      contactPhone: '07000000011',
      plan: 'starter',
      status: 'active',
    });
    const b = createOrganization({
      name: 'Noodle House Branding B',
      contactName: 'B',
      contactEmail: `judie-brand-b-${Date.now()}@example.com`,
      contactPhone: '07000000012',
      plan: 'starter',
      status: 'active',
    });
    orgA = a.id;
    orgB = b.id;
    createdOrgIds.push(orgA, orgB);

    withOrgContext(orgA, () => {
      updateAgentSettings({ aboutUs: 'Curry Palace on High Street  open until 11.' });
    });
    withOrgContext(orgB, () => {
      updateAgentSettings({ aboutUs: 'Noodle House by the station  cash or card.' });
    });
  });

  after(() => {
    for (const id of createdOrgIds) {
      try { deleteOrganization(id); } catch { /* ignore */ }
    }
  });

  it('greets and prompts as routed restaurant A, not Sync2Dine / org B', async () => {
    const session = await buildBrainSession({
      partyPhone: '+447700900111',
      direction: 'inbound',
      identity: dinerIdentity(),
      verified: false,
      agentPersona: 'judie',
      orgId: orgA,
    });
    assert.equal(session.id, 'judie');
    assert.match(session.firstMessage, /^Hello Curry Palace Branding A, how can I help you today\?$/i);
    assert.doesNotMatch(session.firstMessage, /Sync2Dine/i);
    assert.doesNotMatch(session.firstMessage, /\bGuest\b/i);
    assert.match(session.assistantName, /Curry Palace Branding A/i);
    assert.match(session.instructions, /Restaurant you represent: Curry Palace Branding A/i);
    assert.match(session.instructions, /Curry Palace on High Street/i);
    assert.doesNotMatch(session.instructions, /Noodle House by the station/i);
    assert.doesNotMatch(session.instructions, /You are Judie, a cheeky female phone assistant for Sync2Dine/i);
  });

  it('isolates org B aboutUs and greeting from org A', async () => {
    const session = await buildBrainSession({
      partyPhone: '+447700900222',
      direction: 'inbound',
      identity: dinerIdentity('+447700900222'),
      verified: false,
      agentPersona: 'judie',
      orgId: orgB,
    });
    assert.match(session.firstMessage, /^Hello Noodle House Branding B, how can I help you today\?$/i);
    assert.match(session.instructions, /Restaurant you represent: Noodle House Branding B/i);
    assert.match(session.instructions, /Noodle House by the station/i);
    assert.doesNotMatch(session.instructions, /Curry Palace on High Street/i);
  });

  it('fails closed when Judie has no trusted orgId', async () => {
    await assert.rejects(
      () => buildBrainSession({
        partyPhone: '+447700900333',
        direction: 'inbound',
        identity: dinerIdentity('+447700900333'),
        verified: false,
        agentPersona: 'judie',
      }),
      /requires trusted orgId/i,
    );
  });
});
