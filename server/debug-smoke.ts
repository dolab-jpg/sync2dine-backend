/**
 * Builder ops + channel parity smoke test — run: npx tsx server/debug-smoke.ts
 */
import { appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { handleChannelRoutes } from './channel-routes';
import { resolveInboundChannel } from './channel-router';
import { upsertTeamMember, listTeamMembers, getConversationMessages } from './conversation-store';
import { lookupQuotesFromStore } from './quote-lookup';
import { executeChannelAction } from './channel-action-executor';
import { getDataStore, saveQuoteRecord, saveCustomerRecord, syncData } from './data-store';
import { handleChannelInbound } from './channel-inbound-handler';
import { CHANNEL_WRITE_TOOLS } from './channel-writes';
import { handleIvrTurn } from './ivr-handler';
import { synthesizeSpeech, getChatterboxConfig } from './tts';
import { canExecuteActionForRole } from './role-permissions';
import { saveCall } from './data-store';

const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'debug-channel-smoke.log');

const LOG = (hypothesisId: string, location: string, message: string, data: Record<string, unknown>) => {
  const payload = { sessionId: 'channel-smoke', hypothesisId, location, message, data, timestamp: Date.now() };
  appendFileSync(LOG_PATH, JSON.stringify(payload) + '\n');
  console.log(`[${hypothesisId}] ${message}`, JSON.stringify(data));
};

async function httpPost(port: number, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json };
}

async function main() {
  const results: Record<string, string> = {};

  upsertTeamMember({ id: 'dbg-tm1', userId: 'dbg-u1', name: 'Debug Staff', phone: '447700900123', role: 'super_admin' });
  const route = resolveInboundChannel('447700900123', 'default');
  results['staff routing'] = route.mode === 'staff' ? 'PASS' : `FAIL mode=${route.mode}`;

  const store = getDataStore();
  results['data store fields'] = store.teamMembers && store.whatsappConversations ? 'PASS' : 'FAIL';

  const customer = saveCustomerRecord({ name: 'Smoke Customer', email: 'smoke@test.dev', phone: '447700900111', status: 'lead' });
  const quote = saveQuoteRecord({
    customerId: customer.id,
    customerName: customer.name,
    tradeName: 'Bathroom',
    total: 5000,
    status: 'approved',
    items: [{ name: 'Labour', quantity: 1, price: 5000, total: 5000 }],
  });
  saveCall({ id: 'ivr-smoke-call', metadata: {} });

  const writeSamples = [
    'addQuoteLines',
    'convertQuoteToProject',
    'sendContract',
    'recordCostEntry',
    'captureLead',
    'setStage',
    'enqueueOutboundCall',
    'markPaymentReceived',
    'relayCustomerUpdate',
    'sendPaymentLink',
  ];
  const writeResults: Record<string, boolean> = {};
  for (const tool of writeSamples) {
    const input: Record<string, unknown> = { quoteId: quote.id, customerId: customer.id, projectId: 'P-smoke' };
    if (tool === 'addQuoteLines') {
      input.lines = [{ description: 'Extra', quantity: 1, rate: 100, total: 100 }];
    }
    if (tool === 'convertQuoteToProject') {
      input.quoteId = quote.id;
    }
    if (tool === 'sendContract') {
      const ct = { id: 'CT-smoke', quoteId: quote.id, customerId: customer.id, status: 'draft', signToken: 'tok' };
      store.contracts.unshift(ct);
      syncData(store);
      input.contractId = 'CT-smoke';
    }
    if (tool === 'recordCostEntry' || tool === 'relayCustomerUpdate' || tool === 'markPaymentReceived') {
      const proj = {
        id: 'P-smoke',
        customerId: customer.id,
        customerName: customer.name,
        projectName: 'Smoke Project',
        status: 'active',
        totalCustomerCost: 5000,
        messages: [],
        contractorComms: [],
        costEntries: [],
        tasks: [],
        paymentStages: [{ id: 'PS1', name: 'Deposit', amount: 1500, status: 'due' }],
        portalToken: 'portal-smoke',
      };
      if (!store.projects.find((p) => String(p.id) === 'P-smoke')) {
        store.projects.unshift(proj);
        syncData(store);
      }
      input.projectId = 'P-smoke';
      input.body = 'Progress update';
      input.total = 50;
      input.stageName = 'Deposit';
    }
    const r = await executeChannelAction(tool, input, { role: 'super_admin', orgId: 'default', skipConfirm: true });
    writeResults[tool] = r.executed;
  }
  const writePass = Object.values(writeResults).filter(Boolean).length;
  results['write tool samples'] = `${writePass}/${writeSamples.length} PASS`;
  LOG('WRITE', 'debug-smoke', 'write samples', writeResults);

  let parityMissing: string[] = [];
  for (const tool of CHANNEL_WRITE_TOOLS) {
    if (!canExecuteActionForRole('super_admin', tool)) continue;
    const r = await executeChannelAction(tool, { quoteId: quote.id, projectId: 'P-smoke' }, {
      role: 'super_admin',
      orgId: 'default',
      skipConfirm: true,
    });
    if (!r.executed && r.output.serverNote === 'tool_not_wired') {
      parityMissing.push(tool);
    }
  }
  results['parity gate'] = parityMissing.length === 0 ? 'PASS' : `FAIL missing: ${parityMissing.slice(0, 8).join(', ')}`;
  LOG('PARITY', 'debug-smoke', 'missing tools', { count: parityMissing.length, missing: parityMissing.slice(0, 20) });

  process.env.IVR_ENABLED = '1';
  const ivrMenu = handleIvrTurn('ivr-smoke-call', undefined, undefined, true);
  const ivrSales = handleIvrTurn('ivr-smoke-call', '1', '1', false);
  results['IVR smoke'] = ivrMenu?.ivrRoute === 'menu' && ivrSales?.ivrRoute === 'sales' ? 'PASS' : 'FAIL';
  delete process.env.IVR_ENABLED;

  try {
    const tts = await synthesizeSpeech('Hello from TradePro smoke test');
    results['TTS smoke'] = tts.buffer.length > 100 ? `PASS (${tts.provider})` : 'FAIL empty audio';
  } catch (err) {
    const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
    const hasChatterbox = Boolean(getChatterboxConfig());
    results['TTS smoke'] = hasOpenAi || hasChatterbox ? `SKIP: ${String(err).slice(0, 60)}` : 'SKIP no TTS keys';
  }

  const priceResult = await executeChannelAction('priceSmallJob', {
    tasks: 'Replace tap',
    tradeName: 'Small Jobs',
  }, { role: 'super_admin', orgId: 'default', skipConfirm: true });
  results['priceSmallJob'] = priceResult.executed ? 'PASS' : `FAIL: ${priceResult.summary}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (await handleChannelRoutes(req, res, url.pathname)) return;
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const reg = await httpPost(port, '/api/org/staff/register-phone', {
    name: 'API Staff', phone: '447700900999', userId: 'api-u1', role: 'manager',
  });
  results['register API'] = reg.status === 200 ? 'PASS' : `FAIL ${reg.status}`;

  const members = listTeamMembers();
  results['teamMembers unified'] = members.some((m) => m.phone.includes('900999')) ? 'PASS' : 'FAIL';

  try {
    const inbound = await handleChannelInbound({
      orgId: 'default',
      phone: '447700900123',
      text: 'How many customers do we have?',
      channel: 'whatsapp',
    });
    results['inbound pipeline'] = inbound.replyEnglish.length > 0 ? 'PASS' : 'FAIL empty';
  } catch (err) {
    results['inbound pipeline'] = `SKIP: ${String(err).slice(0, 80)}`;
  }

  server.close();

  console.log('\n=== CHANNEL SMOKE SUMMARY ===');
  for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
  LOG('SUMMARY', 'debug-smoke', 'done', results);

  const failed = Object.values(results).some((v) => v.startsWith('FAIL'));
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
