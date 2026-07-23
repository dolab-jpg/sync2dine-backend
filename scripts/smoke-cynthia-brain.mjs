import { buildBrainSession, resolveBrainId } from '../server/brains/index.ts';
import { resolvePhoneCallerIdentity } from '../server/phone/phone-auth.ts';

const identity = resolvePhoneCallerIdentity('+447700900000', 'test-org');
const id = resolveBrainId({ agentPersona: 'cynthia', callMeta: { linePurpose: 'cynthia' } });
const session = await buildBrainSession({
  partyPhone: '+447700900000',
  direction: 'inbound',
  identity,
  verified: false,
  agentPersona: 'cynthia',
  callMeta: { linePurpose: 'cynthia', resolvedOrgId: 'test-org' },
});

const ok =
  id === 'cynthia'
  && session.id === 'cynthia'
  && session.assistantName.includes('Builder Diddies')
  && session.firstMessage.includes('Cynthia')
  && session.allowTransfer === true
  && session.chatTools.length > 0;

console.log(JSON.stringify({
  ok,
  resolveId: id,
  sessionId: session.id,
  assistantName: session.assistantName,
  firstMessage: session.firstMessage,
  tools: session.chatTools.length,
  allowTransfer: session.allowTransfer,
  identityKind: identity.kind,
}, null, 2));

process.exit(ok ? 0 : 1);
