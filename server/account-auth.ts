import { randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { getSupabaseAdmin } from './supabase-admin.js';

export type UserRole =
  | 'platform_owner'
  | 'super_admin'
  | 'manager'
  | 'staff'
  | 'builder'
  | 'recruitment'
  | 'customer';

const INVITE_ROLES: UserRole[] = [
  'super_admin',
  'manager',
  'staff',
  'builder',
  'recruitment',
  'customer',
];

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function validateUsername(value: string): string | null {
  const u = normalizeUsername(value);
  if (!USERNAME_RE.test(u)) {
    return 'Username must be 3–30 characters: lowercase letters, numbers, dots, underscores, or hyphens.';
  }
  return null;
}

async function usernameTaken(username: string, excludeId?: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  let q = supabase.from('profiles').select('id').eq('username', username).limit(1);
  if (excludeId) q = q.neq('id', excludeId);
  const { data } = await q.maybeSingle();
  return Boolean(data?.id);
}

async function createAuthUser(input: {
  email: string;
  password: string;
  name: string;
  username: string;
  role: UserRole;
  orgId: string | null;
}): Promise<{ id: string }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      name: input.name,
      username: input.username,
      role: input.role,
      org_id: input.orgId ?? '',
    },
  });
  if (error || !data.user) {
    throw new Error(error?.message ?? 'Failed to create user');
  }
  const { error: profileError } = await supabase.from('profiles').upsert({
    id: data.user.id,
    email: input.email,
    name: input.name,
    username: input.username,
    role: input.role,
    org_id: input.orgId,
    updated_at: new Date().toISOString(),
  });
  if (profileError) {
    await supabase.auth.admin.deleteUser(data.user.id);
    throw new Error(profileError.message);
  }
  return { id: data.user.id };
}

async function getProfileByBearer(req: IncomingMessage) {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7).trim()
    : null;
  if (!token) return null;

  const supabase = getSupabaseAdmin();
  const { data: authData } = await supabase.auth.getUser(token);
  if (!authData?.user) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, name, username, role, org_id')
    .eq('id', authData.user.id)
    .maybeSingle();
  return profile ?? null;
}

export async function handleAccountAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  try {
    if (pathname === '/api/auth/resolve-username' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { username?: string };
      const username = normalizeUsername(String(body.username ?? ''));
      if (!username) {
        sendJson(res, 400, { error: 'Username is required' });
        return true;
      }
      const supabase = getSupabaseAdmin();
      const { data } = await supabase
        .from('profiles')
        .select('email')
        .eq('username', username)
        .maybeSingle();
      if (!data?.email) {
        sendJson(res, 404, { error: 'User not found' });
        return true;
      }
      sendJson(res, 200, { email: data.email });
      return true;
    }

    if (pathname === '/api/auth/register-org' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as {
        companyName?: string;
        name?: string;
        username?: string;
        email?: string;
        password?: string;
      };
      const companyName = String(body.companyName ?? '').trim();
      const name = String(body.name ?? '').trim();
      const username = normalizeUsername(String(body.username ?? ''));
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');

      if (!companyName || !name || !email) {
        sendJson(res, 400, { error: 'Company name, your name, and email are required' });
        return true;
      }
      const usernameError = validateUsername(username);
      if (usernameError) {
        sendJson(res, 400, { error: usernameError });
        return true;
      }
      if (password.length < 8) {
        sendJson(res, 400, { error: 'Password must be at least 8 characters' });
        return true;
      }
      if (await usernameTaken(username)) {
        sendJson(res, 409, { error: 'Username is already taken' });
        return true;
      }

      const supabase = getSupabaseAdmin();
      const { data: existingEmail } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle();
      if (existingEmail) {
        sendJson(res, 409, { error: 'An account with this email already exists' });
        return true;
      }

      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .insert({
          name: companyName,
          contact_name: name,
          contact_email: email,
          contact_phone: '',
          plan: 'starter',
          status: 'trial',
          monthly_token_cap: 500_000,
          openai_api_key_encrypted: '',
          trial_ends_at: new Date(Date.now() + 14 * 86400000).toISOString(),
        })
        .select()
        .single();

      if (orgError || !org) {
        sendJson(res, 500, { error: orgError?.message ?? 'Failed to create organization' });
        return true;
      }

      try {
        const user = await createAuthUser({
          email,
          password,
          name,
          username,
          role: 'super_admin',
          orgId: org.id,
        });
        sendJson(res, 201, {
          organization: { id: org.id, name: org.name },
          user: { id: user.id, email, name, username, role: 'super_admin', org_id: org.id },
        });
      } catch (err) {
        await supabase.from('organizations').delete().eq('id', org.id);
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'Failed to create user' });
      }
      return true;
    }

    if (pathname.startsWith('/api/auth/invites/') && req.method === 'GET') {
      const token = decodeURIComponent(pathname.slice('/api/auth/invites/'.length)).trim();
      if (!token || token === 'invalid') {
        sendJson(res, 404, { error: 'Invite not found' });
        return true;
      }
      const supabase = getSupabaseAdmin();
      const { data: invite } = await supabase
        .from('org_invites')
        .select('token, email, role, expires_at, accepted_at, org_id, organizations(name)')
        .eq('token', token)
        .maybeSingle();

      if (!invite) {
        sendJson(res, 404, { error: 'Invite not found' });
        return true;
      }
      if (invite.accepted_at) {
        sendJson(res, 410, { error: 'Invite already accepted' });
        return true;
      }
      if (new Date(invite.expires_at).getTime() < Date.now()) {
        sendJson(res, 410, { error: 'Invite expired' });
        return true;
      }
      const orgName =
        invite.organizations && typeof invite.organizations === 'object' && 'name' in invite.organizations
          ? String((invite.organizations as { name: string }).name)
          : 'Your company';
      sendJson(res, 200, {
        token: invite.token,
        email: invite.email,
        role: invite.role,
        orgId: invite.org_id,
        orgName,
        expiresAt: invite.expires_at,
      });
      return true;
    }

    if (pathname === '/api/auth/invites' && req.method === 'POST') {
      const profile = await getProfileByBearer(req);
      if (!profile || !['super_admin', 'platform_owner', 'manager'].includes(profile.role)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return true;
      }
      const body = JSON.parse(await readBody(req)) as {
        email?: string;
        role?: string;
        orgId?: string;
      };
      const email = String(body.email ?? '').trim().toLowerCase();
      const role = String(body.role ?? 'staff') as UserRole;
      if (!email.includes('@')) {
        sendJson(res, 400, { error: 'Valid email is required' });
        return true;
      }
      if (!INVITE_ROLES.includes(role)) {
        sendJson(res, 400, { error: 'Invalid role' });
        return true;
      }
      const orgId =
        profile.role === 'platform_owner' && body.orgId?.trim()
          ? body.orgId.trim()
          : profile.org_id;
      if (!orgId) {
        sendJson(res, 400, { error: 'Organization is required' });
        return true;
      }

      const token = randomBytes(24).toString('hex');
      const supabase = getSupabaseAdmin();
      const { data: invite, error } = await supabase
        .from('org_invites')
        .insert({
          token,
          org_id: orgId,
          email,
          role,
          invited_by: profile.id,
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        })
        .select()
        .single();
      if (error || !invite) {
        sendJson(res, 500, { error: error?.message ?? 'Failed to create invite' });
        return true;
      }
      const baseUrl = process.env.APP_BASE_URL?.trim() || 'http://localhost:5174';
      sendJson(res, 201, {
        invite: {
          id: invite.id,
          token: invite.token,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expires_at,
          acceptUrl: `${baseUrl}/invite/${invite.token}`,
        },
      });
      return true;
    }

    if (pathname === '/api/auth/accept-invite' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as {
        token?: string;
        name?: string;
        username?: string;
        password?: string;
      };
      const token = String(body.token ?? '').trim();
      const name = String(body.name ?? '').trim();
      const username = normalizeUsername(String(body.username ?? ''));
      const password = String(body.password ?? '');
      if (!token || !name) {
        sendJson(res, 400, { error: 'Invite token and name are required' });
        return true;
      }
      const usernameError = validateUsername(username);
      if (usernameError) {
        sendJson(res, 400, { error: usernameError });
        return true;
      }
      if (password.length < 8) {
        sendJson(res, 400, { error: 'Password must be at least 8 characters' });
        return true;
      }
      if (await usernameTaken(username)) {
        sendJson(res, 409, { error: 'Username is already taken' });
        return true;
      }

      const supabase = getSupabaseAdmin();
      const { data: invite } = await supabase
        .from('org_invites')
        .select('*')
        .eq('token', token)
        .maybeSingle();
      if (!invite) {
        sendJson(res, 404, { error: 'Invite not found' });
        return true;
      }
      if (invite.accepted_at) {
        sendJson(res, 410, { error: 'Invite already accepted' });
        return true;
      }
      if (new Date(invite.expires_at).getTime() < Date.now()) {
        sendJson(res, 410, { error: 'Invite expired' });
        return true;
      }

      try {
        const user = await createAuthUser({
          email: invite.email,
          password,
          name,
          username,
          role: invite.role as UserRole,
          orgId: invite.org_id,
        });
        await supabase
          .from('org_invites')
          .update({
            accepted_at: new Date().toISOString(),
            user_id: user.id,
          })
          .eq('id', invite.id);
        sendJson(res, 201, {
          user: {
            id: user.id,
            email: invite.email,
            name,
            username,
            role: invite.role,
            org_id: invite.org_id,
          },
        });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'Failed to accept invite' });
      }
      return true;
    }

    if (pathname === '/api/auth/username-available' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const username = normalizeUsername(url.searchParams.get('username') ?? '');
      if (!username) {
        sendJson(res, 400, { error: 'Username is required' });
        return true;
      }
      const taken = await usernameTaken(username);
      sendJson(res, 200, { available: !taken });
      return true;
    }

    return false;
  } catch (err) {
    console.error('account-auth error:', err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
    return true;
  }
}
