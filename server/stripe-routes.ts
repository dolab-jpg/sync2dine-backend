import type { IncomingMessage, ServerResponse } from 'http';
import { getStripe, handleStripeWebhookEvent } from './stripe-service';
import { getStripeRuntimeConfig } from './stripe-config';
import { getProfileByBearer } from './account-auth';
import { requireAuth } from './auth';
import {
  buildPublicQuoteCheckoutUrl,
  createCheckoutSessionForQuote,
  getQuoteForOrg,
  isQuotePayable,
  upsertQuoteForOrg,
  verifyQuoteCheckoutToken,
} from './quote-checkout';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Accept Supabase session tokens (SPA) or legacy platform JWT. */
async function resolveStaffAuth(req: IncomingMessage): Promise<{
  role: string;
  orgId: string | null;
} | null> {
  const profile = await getProfileByBearer(req);
  if (profile) {
    const role = String(profile.role ?? '');
    const profileOrg = typeof profile.org_id === 'string' ? profile.org_id.trim() : '';
    const requestedOrgId = typeof req.headers['x-org-id'] === 'string'
      ? req.headers['x-org-id'].trim()
      : '';
    if (role === 'platform_owner') {
      return { role, orgId: requestedOrgId || profileOrg || null };
    }
    return { role, orgId: profileOrg || null };
  }
  const auth = requireAuth(req);
  if (!auth) return null;
  return { role: auth.role, orgId: auth.orgId };
}

export async function handleStripeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url?: URL,
): Promise<boolean> {
  if (pathname === '/api/stripe/webhook' && req.method === 'POST') {
    const sig = req.headers['stripe-signature'];
    const secret = getStripeRuntimeConfig().webhookSecret;
    if (!secret) {
      sendJson(res, 503, { error: 'STRIPE_WEBHOOK_SECRET not configured' });
      return true;
    }
    if (!sig || typeof sig !== 'string') {
      sendJson(res, 400, { error: 'Missing stripe-signature header' });
      return true;
    }

    try {
      const rawBody = await readBody(req);
      const stripe = getStripe();
      const event = stripe.webhooks.constructEvent(rawBody, sig, secret);
      await handleStripeWebhookEvent(event);
      sendJson(res, 200, { received: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const checkoutLinkMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/checkout-link$/);
  if (checkoutLinkMatch && req.method === 'POST') {
    const auth = await resolveStaffAuth(req);
    if (!auth) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const quoteId = decodeURIComponent(checkoutLinkMatch[1]);
    const requestedOrgId = typeof req.headers['x-org-id'] === 'string'
      ? req.headers['x-org-id'].trim()
      : '';
    const orgId = auth.role === 'platform_owner' ? (requestedOrgId || auth.orgId) : auth.orgId;
    if (!orgId) {
      sendJson(res, 400, {
        error: auth.role === 'platform_owner'
          ? 'Platform owner must provide X-Org-Id'
          : 'User is not assigned to an organization',
      });
      return true;
    }
    if (auth.role !== 'platform_owner' && requestedOrgId && requestedOrgId !== auth.orgId) {
      sendJson(res, 403, { error: 'Forbidden — wrong organization' });
      return true;
    }
    try {
      const raw = await readBody(req);
      if (raw.length) {
        const body = JSON.parse(raw.toString('utf8')) as { quote?: Record<string, unknown> };
        if (body.quote) {
          if (String(body.quote.id ?? '') !== quoteId) {
            sendJson(res, 400, { error: 'Quote payload id does not match URL' });
            return true;
          }
          await upsertQuoteForOrg(body.quote, orgId);
        }
      }
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid quote payload' });
      return true;
    }
    const quote = await getQuoteForOrg(quoteId, orgId);
    if (!quote) {
      sendJson(res, 404, { error: 'Quote not found' });
      return true;
    }
    const payable = isQuotePayable(quote);
    if (!payable.ok) {
      sendJson(res, 409, { error: payable.reason });
      return true;
    }
    try {
      const baseUrl = process.env.APP_BASE_URL?.trim() || 'http://localhost:3001';
      const checkoutUrl = buildPublicQuoteCheckoutUrl(quote, orgId, baseUrl);
      sendJson(res, 200, {
        quoteId,
        checkoutUrl,
        expiresAt: quote.expiresAt ?? quote.expires_at,
      });
    } catch (err) {
      sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const publicCheckoutMatch = pathname.match(/^\/api\/public\/quotes\/([^/]+)\/checkout$/);
  if (publicCheckoutMatch && req.method === 'GET') {
    const quoteId = decodeURIComponent(publicCheckoutMatch[1]);
    const requestUrl = url ?? new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
    const token = requestUrl.searchParams.get('t') || '';
    const payload = verifyQuoteCheckoutToken(token, quoteId);
    if (!payload) {
      sendJson(res, 401, { error: 'Invalid or expired checkout token' });
      return true;
    }
    const quote = await getQuoteForOrg(quoteId, payload.orgId);
    if (!quote) {
      sendJson(res, 404, { error: 'Quote not found' });
      return true;
    }
    const payable = isQuotePayable(quote);
    if (!payable.ok) {
      sendJson(res, 409, { error: payable.reason });
      return true;
    }
    try {
      const baseUrl = process.env.APP_BASE_URL?.trim() || 'http://localhost:5174';
      const stripeUrl = await createCheckoutSessionForQuote(quote, payload.orgId, baseUrl);
      res.statusCode = 303;
      res.setHeader('Location', stripeUrl);
      res.setHeader('Cache-Control', 'no-store');
      res.end();
    } catch (err) {
      sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}
