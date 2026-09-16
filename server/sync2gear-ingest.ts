/**
 * POST /api/integrations/sync2gear/ingest
 *
 * Receives field-visit callback leads from Sync2Gear (FloorMix admin).
 * HMAC-authenticated with timestamp anti-replay.
 *
 * Always runs under the Sync2Dine home org — never a restaurant PAYG tenant.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  getDataStore,
  lookupContactByPhone,
  normalizePhoneExport,
  saveCustomerRecord,
  setRequestOrgId,
  syncData,
  enqueueOutboundCall,
} from './data-store';
import { getHomeOrgId } from './home-org';
import { toUkE164, isPlausibleUkE164 } from './phone/vapi-client';
import { normalizeDialableE164 } from './phone/tools/leads';
import { captureOrUpdateLead } from './phone/tools/leads';
import { scheduleSallyOutboundDial } from './sally/schedule-outbound';
import { assessContactEligibility } from './sally/call-eligibility';

// ─── HMAC helpers ────────────────────────────────────────────────────

const S2G_TIMESTAMP_HEADER = 'x-s2g-timestamp';
const S2G_SIGNATURE_HEADER = 'x-s2g-signature';
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000; // 5 minutes

function getIngestSecret(): string {
  return (process.env.SYNC2GEAR_INGEST_SECRET ?? '').trim();
}

function computeHmac(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
}

function verifyHmac(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  if (!secret || !signature) return false;
  const expected = computeHmac(secret, timestamp, body);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ─── JSON / HTTP helpers ─────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: string | Buffer) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function headerString(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && raw[0]) return raw[0].trim();
  return '';
}

// ─── Placeholder email filter ────────────────────────────────────────

const PLACEHOLDER_EMAIL_DOMAINS = ['floormix.lead', 'floormix.trial'];

function isPlaceholderEmail(email: string | undefined | null): boolean {
  if (!email) return true;
  const lower = email.trim().toLowerCase();
  if (!lower || !lower.includes('@')) return true;
  return PLACEHOLDER_EMAIL_DOMAINS.some((d) => lower.endsWith(`@${d}`));
}

// ─── Ingest body type ────────────────────────────────────────────────

interface Sync2GearIngestBody {
  sync2gearLeadId: string;
  businessName: string;
  contactName?: string;
  phone: string;
  email?: string;
  city?: string;
  notes?: string;
  callbackAt?: string | null;
  brief?: string;
  marketingOptOut?: boolean;
  assignedSalesStaffId?: string;
}

// ─── Route handler ───────────────────────────────────────────────────

export async function handleSync2GearIngestRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/integrations/sync2gear/ingest') return false;

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  // ── 1. Read body & verify HMAC ──────────────────────────────────────

  const secret = getIngestSecret();
  if (!secret) {
    console.error('[sync2gear-ingest] SYNC2GEAR_INGEST_SECRET not configured');
    sendJson(res, 503, { error: 'ingest_not_configured' });
    return true;
  }

  const rawBody = await readBody(req);
  const timestamp = headerString(req, S2G_TIMESTAMP_HEADER);
  const signature = headerString(req, S2G_SIGNATURE_HEADER);

  if (!timestamp || !signature) {
    sendJson(res, 401, { error: 'missing_auth_headers' });
    return true;
  }

  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > MAX_TIMESTAMP_DRIFT_MS) {
    sendJson(res, 401, { error: 'timestamp_expired' });
    return true;
  }

  if (!verifyHmac(secret, timestamp, rawBody, signature)) {
    sendJson(res, 401, { error: 'invalid_signature' });
    return true;
  }

  // ── 2. Parse body ──────────────────────────────────────────────────

  let data: Sync2GearIngestBody;
  try {
    data = JSON.parse(rawBody) as Sync2GearIngestBody;
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return true;
  }

  if (!data.sync2gearLeadId || !data.businessName) {
    sendJson(res, 400, { error: 'missing_required_fields', detail: 'sync2gearLeadId and businessName are required' });
    return true;
  }

  // ── 3. Set org context to home org ─────────────────────────────────

  setRequestOrgId(getHomeOrgId());

  // ── 4. Normalize phone ─────────────────────────────────────────────

  const phoneE164 = normalizeDialableE164(data.phone);
  if (data.callbackAt && !phoneE164) {
    sendJson(res, 400, { error: 'invalid_phone', detail: 'Callback requested but phone is not a valid UK number' });
    return true;
  }

  // ── 5. Match / deduplicate customer ────────────────────────────────

  const store = getDataStore();
  const customers = store.customers as Array<Record<string, unknown>>;

  // 5a. Match by sync2gearLeadId first
  let existing = customers.find(
    (c) => String(c.sync2gearLeadId ?? '') === data.sync2gearLeadId,
  );

  // 5b. Match by phone
  if (!existing && phoneE164) {
    const phoneLookup = lookupContactByPhone(phoneE164);
    if (phoneLookup.found && phoneLookup.customerId) {
      const byPhone = customers.find((c) => String(c.id) === phoneLookup.customerId);
      if (byPhone) {
        // Name clash guard: if phone matches but the business name is different, reject
        const existingName = String(byPhone.name ?? '').trim().toLowerCase();
        const incomingName = data.businessName.trim().toLowerCase();
        if (existingName && incomingName && existingName !== incomingName && existingName !== 'unknown restaurant') {
          sendJson(res, 409, {
            error: 'name_mismatch',
            detail: `Phone matches existing "${byPhone.name}" but incoming name is "${data.businessName}". Review manually.`,
            existingCustomerId: byPhone.id,
          });
          return true;
        }
        existing = byPhone;
      }
    }
  }

  // 5c. Match by email (skip placeholders)
  const email = data.email?.trim().toLowerCase();
  if (!existing && email && !isPlaceholderEmail(email)) {
    existing = customers.find(
      (c) => String(c.email ?? '').trim().toLowerCase() === email && email.length > 3,
    );
  }

  // ── 6. Save / update customer ──────────────────────────────────────

  const cleanEmail = isPlaceholderEmail(data.email) ? undefined : data.email?.trim();

  const customerPayload: Record<string, unknown> = {
    ...(existing ? { id: existing.id } : {}),
    name: data.businessName,
    ...(data.contactName ? { contactName: data.contactName } : {}),
    ...(phoneE164 ? { phone: phoneE164 } : {}),
    ...(cleanEmail ? { email: cleanEmail } : {}),
    ...(data.city ? { city: data.city } : {}),
    ...(data.notes ? { notes: [existing?.notes, data.notes].filter(Boolean).join(' | ') } : {}),
    source: existing?.source ?? 'sync2gear',
    consentSource: 'sync2gear_callback',
    consentToCall: data.marketingOptOut ? false : (existing?.consentToCall ?? true),
    sync2gearLeadId: data.sync2gearLeadId,
    ...(data.assignedSalesStaffId ? { sync2gearRepId: data.assignedSalesStaffId } : {}),
    status: existing?.status ?? 'lead',
  };

  const customer = saveCustomerRecord(customerPayload);
  const customerId = String(customer.id);

  // ── 7. Schedule outbound if callbackAt + eligible ──────────────────

  let jobId: string | undefined;
  let scheduledAt: string | null = null;
  let skipped = false;
  let reason: string | undefined;

  if (data.callbackAt && phoneE164) {
    // Marketing opt-out → skip dial
    if (data.marketingOptOut) {
      skipped = true;
      reason = 'marketing_opt_out';
    } else {
      // Eligibility check (DNC / consent)
      const eligibility = assessContactEligibility(customer as Record<string, unknown>);
      if (!eligibility.eligible) {
        skipped = true;
        reason = eligibility.reason;
      } else {
        // Idempotency: cancel any pending jobs with same sync2gearLeadId + source
        const queue = store.outboundQueue ?? [];
        for (const job of queue) {
          if (String(job.status) !== 'queued') continue;
          const ctx = (job.context && typeof job.context === 'object')
            ? (job.context as Record<string, unknown>)
            : {};
          if (
            String(ctx.sync2gearLeadId ?? '') === data.sync2gearLeadId
            && String(ctx.source ?? '') === 'sync2gear_callback'
          ) {
            (job as Record<string, unknown>).status = 'cancelled';
            (job as Record<string, unknown>).cancelledAt = new Date().toISOString();
            (job as Record<string, unknown>).cancelReason = 'superseded_by_new_ingest';
          }
        }
        syncData(store);

        const result = scheduleSallyOutboundDial({
          to: phoneE164,
          customerId,
          customerName: data.contactName || data.businessName,
          company: data.businessName,
          template: 'sally_sales',
          source: 'sync2gear_callback',
          brief: data.brief || 'Sync2Gear field visit follow-up. Do not pitch Sync2Dine unless asked.',
          scheduledAt: data.callbackAt,
          venueAware: false,
          customer: customer as Record<string, unknown>,
          context: {
            sync2gearLeadId: data.sync2gearLeadId,
            source: 'sync2gear_callback',
            assignedSalesStaffId: data.assignedSalesStaffId,
          },
        });

        if (result.ok && !result.skipped) {
          jobId = result.job ? String(result.job.id) : undefined;
          scheduledAt = result.scheduledAt ?? null;
        } else {
          skipped = true;
          reason = result.reason;
        }
      }
    }
  }

  // ── 8. Response ────────────────────────────────────────────────────

  console.log(
    `[sync2gear-ingest] ${existing ? 'updated' : 'created'} customer=${customerId} s2gLead=${data.sync2gearLeadId}` +
    (jobId ? ` job=${jobId} at=${scheduledAt}` : '') +
    (skipped ? ` skipped=${reason}` : ''),
  );

  sendJson(res, 200, {
    customerId,
    jobId: jobId ?? null,
    scheduledAt,
    skipped,
    reason: reason ?? null,
  });
  return true;
}
