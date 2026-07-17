import { createHmac, timingSafeEqual } from 'crypto';

export const S2D_SIGNATURE_HEADER = 'x-s2d-signature';

export function signPayload(secret: string, body: string): string {
  const digest = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

export function verifySignature(secret: string, body: string, header: string | undefined | null): boolean {
  if (!secret?.trim() || !header?.trim()) return false;
  const expected = signPayload(secret, body);
  const provided = header.trim().startsWith('sha256=') ? header.trim() : `sha256=${header.trim()}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}
