import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const DEPLOY_ENV_KEYS = {
  supabaseAccessToken: 'SUPABASE_ACCESS_TOKEN',
  supabaseProjectRef: 'SUPABASE_PROJECT_REF',
} as const;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function isLocalhost(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  return host.startsWith('localhost:') || host.startsWith('127.0.0.1:');
}

/**
 * deploy.env resolution order:
 * 1. DEPLOY_ENV_PATH env var (explicit override for standalone/VPS deployments)
 * 2. <repo root>/.cursor/local/deploy.env
 * (Writes always target the resolved path so reads and writes stay consistent.)
 */
function getDeployEnvPath(): string {
  const fromEnv = process.env.DEPLOY_ENV_PATH?.trim();
  if (fromEnv) return fromEnv;
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(serverDir, '..', '.cursor', 'local', 'deploy.env');
}

/** Dev-only sibling fallback: ../<frontend workspace>/.cursor/local/deploy.env */
function getDeployEnvFallbackPath(): string | null {
  if (process.env.NODE_ENV === 'production') return null;
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(serverDir, '..', '..', 'Bathroom Sales Estimation Platform', '.cursor', 'local', 'deploy.env');
}

function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

async function readDeployEnv(): Promise<{ vars: Record<string, string>; savedAt: string | null }> {
  const candidates = [getDeployEnvPath(), getDeployEnvFallbackPath()].filter(
    (p): p is string => Boolean(p),
  );
  for (const deployPath of candidates) {
    try {
      const content = await readFile(deployPath, 'utf8');
      const fileStat = await stat(deployPath);
      return { vars: parseEnvFile(content), savedAt: fileStat.mtime.toISOString() };
    } catch {
      // try next candidate
    }
  }
  return { vars: {}, savedAt: null };
}

async function writeDeployEnv(updates: Record<string, string>): Promise<void> {
  const deployPath = getDeployEnvPath();
  await mkdir(path.dirname(deployPath), { recursive: true });

  let existing: Record<string, string> = {};
  try {
    existing = parseEnvFile(await readFile(deployPath, 'utf8'));
  } catch {
    // new file
  }

  const merged = { ...existing, ...updates };
  const lines = [
    '# Written by /cursor-paste — gitignored. Do not commit.',
    ...Object.entries(merged).map(([key, value]) => `${key}=${value}`),
    '',
  ];
  await writeFile(deployPath, lines.join('\n'), 'utf8');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function resolveToken(body: { supabaseAccessToken?: string }): Promise<string | null> {
  const fromBody = body.supabaseAccessToken?.trim();
  if (fromBody) return fromBody;
  const { vars } = await readDeployEnv();
  return vars.SUPABASE_ACCESS_TOKEN?.trim() || null;
}

async function supabaseApiGet(token: string, path: string): Promise<Response> {
  return fetch(`https://api.supabase.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function supabaseApiPost(token: string, path: string, payload: unknown): Promise<Response> {
  return fetch(`https://api.supabase.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

export async function handleAgentCredentialsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith('/api/agent/credentials')) return false;

  if (pathname === '/api/agent/credentials/status' && req.method === 'GET') {
    const { vars, savedAt } = await readDeployEnv();
    const keys = Object.keys(vars).filter((k) => Boolean(vars[k]?.trim()));
    const envVapi = Boolean(process.env.VAPI_PRIVATE_KEY?.trim() || process.env.VAPI_API_KEY?.trim() || vars.VAPI_PRIVATE_KEY?.trim());
    sendJson(res, 200, {
      ready: keys.length > 0 || envVapi,
      keys,
      savedAt,
      localhost: isLocalhost(req),
      vapi: {
        hasPrivateKey: envVapi,
        phoneNumberId: Boolean(process.env.VAPI_PHONE_NUMBER_ID?.trim() || vars.VAPI_PHONE_NUMBER_ID?.trim()),
        webhookBaseUrl: process.env.VAPI_WEBHOOK_BASE_URL?.trim() || vars.VAPI_WEBHOOK_BASE_URL?.trim() || null,
        region: process.env.VAPI_REGION || vars.VAPI_REGION || 'eu',
        voiceProvider: process.env.VOICE_PROVIDER || 'soho66',
      },
      masked: {
        supabaseAccessToken: vars.SUPABASE_ACCESS_TOKEN
          ? maskSecret(vars.SUPABASE_ACCESS_TOKEN)
          : null,
        supabaseProjectRef: vars.SUPABASE_PROJECT_REF
          ? maskSecret(vars.SUPABASE_PROJECT_REF)
          : null,
        vapiPrivateKey: (process.env.VAPI_PRIVATE_KEY || vars.VAPI_PRIVATE_KEY)
          ? maskSecret(String(process.env.VAPI_PRIVATE_KEY || vars.VAPI_PRIVATE_KEY))
          : null,
        elevenLabsApiKey: (process.env.ELEVENLABS_API_KEY || vars.ELEVENLABS_API_KEY)
          ? maskSecret(String(process.env.ELEVENLABS_API_KEY || vars.ELEVENLABS_API_KEY))
          : null,
      },
    });
    return true;
  }

  if (pathname === '/api/agent/credentials/vapi' && req.method === 'POST') {
    if (!isLocalhost(req)) {
      sendJson(res, 403, { error: 'Only allowed on localhost' });
      return true;
    }
    let body: {
      vapiPrivateKey?: string;
      vapiWebhookBaseUrl?: string;
      elevenLabsApiKey?: string;
      elevenLabsVoiceId?: string;
      region?: string;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const updates: Record<string, string> = {};
    if (body.vapiPrivateKey?.trim()) updates.VAPI_PRIVATE_KEY = body.vapiPrivateKey.trim();
    if (body.vapiWebhookBaseUrl?.trim()) updates.VAPI_WEBHOOK_BASE_URL = body.vapiWebhookBaseUrl.trim().replace(/\/$/, '');
    if (body.elevenLabsApiKey?.trim()) updates.ELEVENLABS_API_KEY = body.elevenLabsApiKey.trim();
    if (body.elevenLabsVoiceId?.trim()) {
      updates.VAPI_ELEVENLABS_VOICE_ID = body.elevenLabsVoiceId.trim();
      updates.ELEVENLABS_VOICE_ID = body.elevenLabsVoiceId.trim();
    }
    if (body.region?.trim()) updates.VAPI_REGION = body.region.trim().toLowerCase() === 'us' ? 'us' : 'eu';
    if (!Object.keys(updates).length) {
      sendJson(res, 400, { error: 'No Vapi fields provided' });
      return true;
    }
    updates.VOICE_PROVIDER = 'vapi';
    await writeDeployEnv(updates);
    // Also mirror into process env for this running process
    for (const [k, v] of Object.entries(updates)) {
      process.env[k] = v;
    }
    // Append into backend .env as well
    try {
      const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
      let content = '';
      try {
        content = await readFile(envPath, 'utf8');
      } catch {
        content = '';
      }
      for (const [key, value] of Object.entries(updates)) {
        const line = `${key}=${value}`;
        const re = new RegExp(`^${key}=.*$`, 'm');
        if (re.test(content)) content = content.replace(re, line);
        else content = `${content.trimEnd()}\n${line}\n`;
      }
      await writeFile(envPath, content, 'utf8');
    } catch {
      // optional
    }
    sendJson(res, 200, {
      ok: true,
      next: 'Restart API if needed, then run: npm run vapi:setup',
      masked: Object.fromEntries(
        Object.entries(updates).map(([k, v]) => [k, k.includes('KEY') || k.includes('SECRET') ? maskSecret(v) : v]),
      ),
    });
    return true;
  }

  if (pathname === '/api/agent/credentials/sync' && req.method === 'POST') {
    if (!isLocalhost(req)) {
      sendJson(res, 403, {
        error: 'Sync only allowed on localhost',
        hint: 'Open http://localhost:5174/cursor-paste on this machine',
      });
      return true;
    }

    let body: { supabaseAccessToken?: string; supabaseProjectRef?: string };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }

    const token = body.supabaseAccessToken?.trim();
    const projectRef = body.supabaseProjectRef?.trim();

    if (!token) {
      sendJson(res, 400, { error: 'supabaseAccessToken is required' });
      return true;
    }

    const updates: Record<string, string> = {
      [DEPLOY_ENV_KEYS.supabaseAccessToken]: token,
    };
    if (projectRef) {
      updates[DEPLOY_ENV_KEYS.supabaseProjectRef] = projectRef;
    }

    await writeDeployEnv(updates);

    sendJson(res, 200, {
      ok: true,
      savedAt: new Date().toISOString(),
      fields: Object.keys(updates),
      hasProjectRef: Boolean(projectRef),
    });
    return true;
  }

  if (pathname === '/api/agent/credentials/projects' && req.method === 'POST') {
    if (!isLocalhost(req)) {
      sendJson(res, 403, { error: 'Only allowed on localhost' });
      return true;
    }

    let body: { supabaseAccessToken?: string };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }

    const token = await resolveToken(body);
    if (!token) {
      sendJson(res, 400, { error: 'Paste your access token first' });
      return true;
    }

    try {
      const response = await supabaseApiGet(token, '/projects');
      if (!response.ok) {
        const text = await response.text();
        sendJson(res, 200, {
          success: false,
          message: `Could not load projects (${response.status}): ${text.slice(0, 200)}`,
          projects: [],
        });
        return true;
      }
      const projects = (await response.json()) as Array<{
        id: string;
        ref: string;
        name: string;
        organization_id: string;
        region: string;
        status: string;
      }>;
      sendJson(res, 200, {
        success: true,
        projects: projects.map((p) => ({
          id: p.id,
          ref: p.ref,
          name: p.name,
          organizationId: p.organization_id,
          region: p.region,
          status: p.status,
        })),
      });
    } catch (err) {
      sendJson(res, 200, {
        success: false,
        message: err instanceof Error ? err.message : 'Failed to load projects',
        projects: [],
      });
    }
    return true;
  }

  if (pathname === '/api/agent/credentials/organizations' && req.method === 'POST') {
    if (!isLocalhost(req)) {
      sendJson(res, 403, { error: 'Only allowed on localhost' });
      return true;
    }

    let body: { supabaseAccessToken?: string };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }

    const token = await resolveToken(body);
    if (!token) {
      sendJson(res, 400, { error: 'Paste your access token first' });
      return true;
    }

    try {
      const response = await supabaseApiGet(token, '/organizations');
      if (!response.ok) {
        const text = await response.text();
        sendJson(res, 200, { success: false, message: text.slice(0, 200), organizations: [] });
        return true;
      }
      const orgs = (await response.json()) as Array<{ id: string; name: string }>;
      sendJson(res, 200, {
        success: true,
        organizations: orgs.map((o) => ({ id: o.id, name: o.name })),
      });
    } catch (err) {
      sendJson(res, 200, {
        success: false,
        message: err instanceof Error ? err.message : 'Failed to load organizations',
        organizations: [],
      });
    }
    return true;
  }

  if (pathname === '/api/agent/credentials/create-project' && req.method === 'POST') {
    if (!isLocalhost(req)) {
      sendJson(res, 403, { error: 'Only allowed on localhost' });
      return true;
    }

    let body: {
      supabaseAccessToken?: string;
      organizationId?: string;
      name?: string;
      region?: string;
      dbPass?: string;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }

    const token = await resolveToken(body);
    const organizationId = body.organizationId?.trim();
    const name = body.name?.trim();
    const region = body.region?.trim() || 'eu-west-2';
    const dbPass = body.dbPass?.trim();

    if (!token || !organizationId || !name || !dbPass) {
      sendJson(res, 400, {
        error: 'Token, organization, project name, and database password are required',
      });
      return true;
    }

    if (dbPass.length < 8) {
      sendJson(res, 400, { error: 'Database password must be at least 8 characters' });
      return true;
    }

    try {
      const response = await supabaseApiPost(token, '/projects', {
        organization_id: organizationId,
        name,
        region,
        db_pass: dbPass,
        plan: 'free',
      });
      const text = await response.text();
      if (!response.ok) {
        sendJson(res, 200, {
          success: false,
          message: `Create failed (${response.status}): ${text.slice(0, 300)}`,
        });
        return true;
      }
      const project = JSON.parse(text) as { ref: string; name: string; id: string };
      await writeDeployEnv({
        [DEPLOY_ENV_KEYS.supabaseAccessToken]: token,
        [DEPLOY_ENV_KEYS.supabaseProjectRef]: project.ref,
      });
      sendJson(res, 200, {
        success: true,
        message: `Created project "${project.name}"`,
        project: { ref: project.ref, name: project.name, id: project.id },
      });
    } catch (err) {
      sendJson(res, 200, {
        success: false,
        message: err instanceof Error ? err.message : 'Failed to create project',
      });
    }
    return true;
  }

  if (pathname === '/api/agent/credentials/test' && req.method === 'POST') {
    if (!isLocalhost(req)) {
      sendJson(res, 403, { error: 'Test only allowed on localhost' });
      return true;
    }

    const { vars } = await readDeployEnv();
    const token = vars.SUPABASE_ACCESS_TOKEN;
    const projectRef = vars.SUPABASE_PROJECT_REF;

    if (!token || !projectRef) {
      sendJson(res, 400, { error: 'Save credentials first' });
      return true;
    }

    try {
      const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const text = await response.text();
        sendJson(res, 200, {
          success: false,
          message: `Supabase API returned ${response.status}: ${text.slice(0, 200)}`,
        });
        return true;
      }
      const project = (await response.json()) as { name?: string };
      sendJson(res, 200, {
        success: true,
        message: project.name ? `Connected to project "${project.name}"` : 'Supabase token valid',
      });
    } catch (err) {
      sendJson(res, 200, {
        success: false,
        message: err instanceof Error ? err.message : 'Connection test failed',
      });
    }
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
