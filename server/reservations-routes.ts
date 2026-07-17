import type { IncomingMessage, ServerResponse } from 'http';
import {
  DEFAULT_ORG_ID,
  setRequestOrgId,
} from './data-store';
import { resolveOrgIdForRequest } from './auth';
import {
  cancelReservation,
  checkTableAvailability,
  createReservation,
  listDiningTables,
  listReservations,
  updateReservation,
  upsertDiningTable,
} from './reservations-store';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function handleReservationsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/reservations') && !pathname.startsWith('/api/dining-tables')) {
    return false;
  }

  const orgId = resolveOrgIdForRequest(req, {}) || DEFAULT_ORG_ID;
  setRequestOrgId(orgId);

  if (pathname === '/api/dining-tables' && req.method === 'GET') {
    const tables = await listDiningTables(orgId);
    sendJson(res, 200, { tables });
    return true;
  }

  if (pathname === '/api/dining-tables' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const result = await upsertDiningTable({
      id: body.id != null ? String(body.id) : undefined,
      label: String(body.label ?? ''),
      seats: Number(body.seats ?? 2),
      zone: body.zone != null ? String(body.zone) : undefined,
      active: body.active !== false,
      sortOrder: Number(body.sortOrder ?? 0),
    }, orgId);
    sendJson(res, result.ok ? 200 : 400, result);
    return true;
  }

  if (pathname === '/api/reservations/availability' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const result = await checkTableAvailability({
      startsAt: String(body.startsAt ?? body.dateTime ?? ''),
      partySize: Number(body.partySize ?? 2),
      durationMinutes: body.durationMinutes != null ? Number(body.durationMinutes) : undefined,
    }, orgId);
    sendJson(res, result.ok ? 200 : 400, result);
    return true;
  }

  if (pathname === '/api/reservations' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const reservations = await listReservations(orgId, {
      day: url.searchParams.get('day') ?? undefined,
      phone: url.searchParams.get('phone') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
    });
    sendJson(res, 200, { reservations });
    return true;
  }

  if (pathname === '/api/reservations' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const result = await createReservation({
      partySize: Number(body.partySize ?? 2),
      startsAt: String(body.startsAt ?? ''),
      customerName: body.customerName != null ? String(body.customerName) : undefined,
      customerPhone: body.customerPhone != null ? String(body.customerPhone) : undefined,
      customerId: body.customerId != null ? String(body.customerId) : undefined,
      tableId: body.tableId != null ? String(body.tableId) : undefined,
      notes: body.notes != null ? String(body.notes) : undefined,
      channel: body.channel != null ? String(body.channel) : undefined,
      callId: body.callId != null ? String(body.callId) : undefined,
      status: body.status as import('./reservations-store').ReservationStatus | undefined,
    }, orgId);
    sendJson(res, result.ok ? 201 : 400, result);
    return true;
  }

  const patchMatch = pathname.match(/^\/api\/reservations\/([^/]+)$/);
  if (patchMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    const id = decodeURIComponent(patchMatch[1]);
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const result = await updateReservation(id, body as Partial<import('./reservations-store').Reservation>, orgId);
    sendJson(res, result.ok ? 200 : result.error === 'not found' ? 404 : 400, result);
    return true;
  }

  const cancelMatch = pathname.match(/^\/api\/reservations\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    const id = decodeURIComponent(cancelMatch[1]);
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const result = await cancelReservation(id, body.reason != null ? String(body.reason) : undefined, orgId);
    sendJson(res, result.ok ? 200 : result.error === 'not found' ? 404 : 400, result);
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
