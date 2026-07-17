/**
 * Pre-live smoke for uncommitted delivery + specials work.
 * Writes NDJSON to workspace debug-61363c.log and POSTs to debug ingest.
 */
import { appendFileSync } from 'fs';
import { join } from 'path';
import {
  matchDeliveryPostcode,
  normalizeDeliveryPrefixes,
  ukOutwardCode,
} from '../server/delivery-areas';
import { orderToRow, rowToOrder } from '../server/supabase-orders';

const LOG = join(
  'C:/Users/dolab/Downloads/Bathroom Sales Estimation Platform',
  'debug-61363c.log',
);

function log(hypothesisId: string, location: string, message: string, data: Record<string, unknown>) {
  const row = {
    sessionId: '61363c',
    runId: 'post-fix',
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  fetch('http://127.0.0.1:7261/ingest/6cf14313-b666-4982-884a-814f1f19f4c6', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '61363c' },
    body: JSON.stringify(row),
  }).catch(() => {});
}

// --- Hypothesis A: postcode matching ---
const prefixes = normalizeDeliveryPrefixes(['B1', 'B11', 'CV1']);
const cases = [
  { pc: 'B1 1AA', expect: true, why: 'exact outward B1' },
  { pc: 'B11 2BB', expect: true, why: 'exact outward B11 (must not collapse to B1)' },
  { pc: 'B12 3CC', expect: false, why: 'B12 not configured' },
  { pc: 'CV1 2DX', expect: true, why: 'CV1 configured' },
  { pc: 'B1', expect: true, why: 'partial equals chip' },
  { pc: '', expect: false, why: 'empty' },
];
let matchFails = 0;
for (const c of cases) {
  const r = matchDeliveryPostcode(c.pc, prefixes);
  const ok = r.ok === c.expect;
  if (!ok) matchFails += 1;
  log('A', 'smoke:match', ok ? 'match case PASS' : 'match case FAIL', {
    pc: c.pc,
    outward: ukOutwardCode(c.pc),
    expect: c.expect,
    got: r.ok,
    matchedPrefix: r.matchedPrefix ?? null,
    why: c.why,
  });
}

// --- Hypothesis B: specials/postcode survive supabase map via notes meta ---
const mapped = orderToRow(
  {
    id: '00000000-0000-4000-8000-000000000099',
    customerName: 'Smoke',
    customerPhone: '07700900000',
    orderType: 'delivery',
    status: 'new',
    paymentStatus: 'unpaid',
    items: [{ name: 'Chicken biryani', qty: 1, price: 9.5 }],
    total: 9.5,
    deliveryAddress: '12 High St, B1 1AA',
    deliveryPostcode: 'B1 1AA',
    specialName: 'Family Friday',
    notes: 'Family Friday: 10% off',
  },
  'c2887ddb-0cba-4df1-9086-e7399c92d159',
);
const notesHasMeta = String(mapped.notes ?? '').includes('[[s2d:');
const roundTrip = rowToOrder({
  id: String(mapped.id),
  org_id: String(mapped.org_id),
  customer_id: null,
  customer_name: String(mapped.customer_name),
  customer_phone: String(mapped.customer_phone),
  channel: String(mapped.channel),
  order_type: String(mapped.order_type),
  status: String(mapped.status),
  payment_status: String(mapped.payment_status),
  payment_method: null,
  order_number: Number(mapped.order_number),
  items: mapped.items,
  total: Number(mapped.total),
  delivery_address: mapped.delivery_address as string,
  notes: String(mapped.notes),
  review_score: null,
  review_text: null,
  review_called_at: null,
  last_winback_call_at: null,
  created_at: String(mapped.created_at),
  updated_at: String(mapped.updated_at),
});
const roundTripOk =
  roundTrip.specialName === 'Family Friday'
  && String(roundTrip.deliveryPostcode).includes('B1')
  && !String(roundTrip.notes ?? '').includes('[[s2d:');
log('B', 'smoke:orderToRow', roundTripOk ? 'round-trip PASS' : 'round-trip FAIL', {
  notesHasMeta,
  roundTripSpecial: roundTrip.specialName ?? null,
  roundTripPc: roundTrip.deliveryPostcode ?? null,
  roundTripNotes: roundTrip.notes ?? null,
  roundTripOk,
});

log('D', 'smoke:live-status', 'expected deploy gap', {
  liveHasMenuCampaigns: true,
  liveHasDeliveryUi: false,
  uncommittedReadyToShip: matchFails === 0 && roundTripOk,
});

console.log(JSON.stringify({
  matchFails,
  notesHasMeta,
  roundTripOk,
  roundTripSpecial: roundTrip.specialName,
  roundTripPc: roundTrip.deliveryPostcode,
  roundTripNotes: roundTrip.notes,
}, null, 2));
