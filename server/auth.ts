import jwt from 'jsonwebtoken';
import type { IncomingMessage, ServerResponse } from 'http';
import { getOrganizationById } from './organizations';
import { getUserById, sanitizeUser, verifyPassword, getUserByEmail, type PlatformUser } from './users';

const JWT_EXPIRY = '7d';

export interface AuthPayload {
  userId: string;
  orgId: string | null;
  role: string;
  email: string;
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) return 'tradepro-dev-jwt-secret-change-in-production';
  return secret;
}

export function signToken(user: PlatformUser): string {
  const payload: AuthPayload = {
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    email: user.email,
  };
  return jwt.sign(payload, jwtSecret(), { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, jwtSecret()) as AuthPayload;
  } catch {
    return null;
  }
}

export function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

export function authenticateRequest(req: IncomingMessage): AuthPayload | null {
  const token = extractBearerToken(req);
  if (!token) return null;
  return verifyToken(token);
}

export interface AuthContext extends AuthPayload {
  user: ReturnType<typeof sanitizeUser>;
}

export function requireAuth(req: IncomingMessage): AuthContext | null {
  const payload = authenticateRequest(req);
  if (!payload) return null;
  const user = getUserById(payload.userId);
  if (!user) return null;

  if (user.orgId) {
    const org = getOrganizationById(user.orgId);
    if (!org) return null;
    if (org.status === 'suspended' || org.status === 'cancelled') {
      return null;
    }
  }

  return { ...payload, user: sanitizeUser(user) };
}

export function loginUser(email: string, password: string): { token: string; user: ReturnType<typeof sanitizeUser> } | null {
  const user = getUserByEmail(email);
  if (!user || !verifyPassword(user, password)) return null;
  if (user.orgId) {
    const org = getOrganizationById(user.orgId);
    if (org && (org.status === 'suspended' || org.status === 'cancelled')) {
      return null;
    }
  }
  return { token: signToken(user), user: sanitizeUser(user) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const { handleAccountAuthRoutes } = await import('./account-auth.js');
  if (await handleAccountAuthRoutes(req, res, pathname)) return true;

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const result = loginUser(String(body.email ?? ''), String(body.password ?? ''));
    if (!result) {
      sendJson(res, 401, { error: 'Invalid email or password' });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const ctx = requireAuth(req);
    if (!ctx) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    sendJson(res, 200, { user: ctx.user, orgId: ctx.orgId, role: ctx.role });
    return true;
  }

  return false;
}

export function isAuthEnforced(): boolean {
  return process.env.AUTH_ENFORCED === 'true';
}

export function resolveOrgIdForRequest(
  req: IncomingMessage,
  body?: { orgId?: string },
): string | null {
  if (isAuthEnforced()) {
    const ctx = requireAuth(req);
    if (ctx?.orgId) return ctx.orgId;
    if (ctx?.role === 'platform_owner') {
      const header = req.headers['x-org-id'];
      if (typeof header === 'string' && header.trim()) return header.trim();
      if (body?.orgId?.trim()) return body.orgId.trim();
    }
    return null;
  }

  const header = req.headers['x-org-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (body?.orgId?.trim()) return body.orgId.trim();
  return null;
}
