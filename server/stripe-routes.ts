import type { IncomingMessage, ServerResponse } from 'http';
import { getStripe, handleStripeWebhookEvent } from './stripe-service';

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

export async function handleStripeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/api/stripe/webhook' && req.method === 'POST') {
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
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

  return false;
}
