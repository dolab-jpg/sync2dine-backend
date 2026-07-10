import type { IncomingMessage } from 'http';

export function resolveOrgIdFromRequest(
  req: IncomingMessage,
  body?: { orgId?: string },
): string | null {
  const header = req.headers['x-org-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim();
  if (body?.orgId?.trim()) return body.orgId.trim();
  return null;
}

export function resolveOrgIdFromBody(body?: { orgId?: string }): string | null {
  return body?.orgId?.trim() || null;
}
