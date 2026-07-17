/**
 * Connector E2E smoke (Direction A + B skeleton).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/connector-e2e.mts
 *
 * Requires API running on PORT (default 3001) or set CONNECTOR_E2E_BASE_URL.
 */
import { createServer } from 'http';
import { signPayload } from '../server/connectors/hmac.js';

const BASE = process.env.CONNECTOR_E2E_BASE_URL?.trim() || `http://127.0.0.1:${process.env.PORT || 3001}`;
const SECRET = process.env.CONNECTOR_WEBHOOK_SECRET?.trim() || 'connector-e2e-test-secret';
const ORG_ID = process.env.CONNECTOR_E2E_ORG_ID?.trim() || '';

type Received = { headers: Record<string, string>; body: unknown };

function waitForPost(port: number, path: string, timeoutMs = 8000): Promise<Received> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== path) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.statusCode = 200;
        res.end('ok');
        server.close();
        resolve({
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : String(v ?? '')]),
          ),
          body: JSON.parse(raw || '{}'),
        });
      });
    });
    server.listen(port);
    setTimeout(() => {
      server.close();
      reject(new Error('mock receiver timeout'));
    }, timeoutMs);
  });
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(ORG_ID ? { 'X-Org-Id': ORG_ID } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return fetch(`${BASE}${path}`, { ...init, headers });
}

async function main() {
  const log: Array<Record<string, unknown>> = [];
  const mockPort = Number(process.env.CONNECTOR_MOCK_PORT || 9876);
  const mockPath = '/mock-status-receiver';

  console.log(`[connector-e2e] base=${BASE}`);

  await api('/api/connectors/config', {
    method: 'PUT',
    body: JSON.stringify({
      provider: 'mock',
      enabled: true,
      direction: 'both',
      outboundUrl: `http://127.0.0.1:${mockPort}${mockPath}`,
      webhookSecret: SECRET,
    }),
  });

  const receiver = waitForPost(mockPort, mockPath);

  const orderBody = {
    externalId: `mock-e2e-${Date.now()}`,
    customerName: 'E2E Tester',
    customerPhone: '+447700900999',
    orderType: 'delivery',
    channelLabel: 'Mock middle-man',
    postcode: 'SW1A 1AA',
    deliveryAddress: '10 Downing St, London',
    customerAllergies: 'sesame',
    allergyConfirmed: true,
    paymentStatus: 'unpaid',
    items: [
      { name: 'Chicken biryani', qty: 1, price: 9.5 },
      { name: 'Garlic naan', qty: 2, price: 2.5 },
    ],
    total: 14.5,
  };
  const raw = JSON.stringify(orderBody);
  const sig = signPayload(SECRET, raw);
  const idem = `idem-${orderBody.externalId}`;

  const inbound = await api('/api/connectors/mock/orders', {
    method: 'POST',
    headers: {
      'X-S2D-Signature': sig,
      'Idempotency-Key': idem,
    },
    body: raw,
  });
  const inboundJson = await inbound.json();
  log.push({ step: 'inbound', status: inbound.status, body: inboundJson });
  console.log('[connector-e2e] inbound', inbound.status, inboundJson);

  const dup = await api('/api/connectors/mock/orders', {
    method: 'POST',
    headers: { 'X-S2D-Signature': sig, 'Idempotency-Key': idem },
    body: raw,
  });
  const dupJson = await dup.json();
  log.push({ step: 'duplicate', status: dup.status, duplicate: dupJson.duplicate === true });

  const badSig = await api('/api/connectors/mock/orders', {
    method: 'POST',
    headers: { 'X-S2D-Signature': 'sha256=deadbeef', 'Idempotency-Key': 'bad' },
    body: raw,
  });
  log.push({ step: 'bad_signature', status: badSig.status });

  if (inboundJson.order?.id) {
    const patch = await api(`/api/orders/${inboundJson.order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ready' }),
    });
    log.push({ step: 'board_bump_ready', status: patch.status });
  }

  let outboundReceived: Received | null = null;
  try {
    outboundReceived = await receiver;
    log.push({ step: 'outbound_received', event: (outboundReceived.body as { event?: string })?.event });
  } catch (err) {
    log.push({ step: 'outbound_received', error: err instanceof Error ? err.message : String(err) });
  }

  const commerce = await api('/api/connectors/commerce/forward', {
    method: 'POST',
    body: JSON.stringify({
      order: {
        id: inboundJson.order?.id ?? 'local-test',
        orderNumber: 999,
        orderType: 'collection',
        customerName: 'Direction B',
        customerPhone: '+447700900888',
        items: orderBody.items,
        total: orderBody.total,
        customerAllergies: 'none',
        allergyConfirmed: true,
        paymentStatus: 'unpaid',
        paymentMethod: 'cash',
      },
    }),
  });
  log.push({ step: 'direction_b_commerce', status: commerce.status });

  const summary = {
    ok: inbound.ok && badSig.status === 401 && dupJson.duplicate === true,
    log,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
