/**
 * Self-heal code-fix queue: CRM chat → Cursor Cloud Agents → GitHub PR.
 * Jobs persist to server/data/code-fix-jobs.json (and Supabase when configured).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveOrgIdForRequest, isAuthEnforced, requireAuth } from './auth';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, 'data', 'code-fix-jobs.json');

const FRONTEND_REPO = 'https://github.com/dolab-jpg/tradepro-frontend';
const BACKEND_REPO = 'https://github.com/dolab-jpg/tradepro-backend';
const REQUIRED_REPOS = ['dolab-jpg/tradepro-frontend', 'dolab-jpg/tradepro-backend'] as const;
const MAX_CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;
const STUCK_MS = 30 * 60 * 1000;
const DEDUPE_MS = 15 * 60 * 1000;
const HEALTH_CACHE_MS = 10 * 60 * 1000;
const HTTP_CLASS_ERROR_CODES = new Set(['HTTP_401', 'HTTP_400', 'HTTP_503']);
const OFFER_DEDUPE_STATUSES: CodeFixStatus[] = [
  'offered',
  'asking',
  'queued',
  'running',
  'awaiting_cursor_approval',
  'pr_open',
];
const ACTIVE_ENQUEUE_STATUSES: CodeFixStatus[] = [
  'queued',
  'running',
  'pr_open',
  'awaiting_cursor_approval',
];

export interface CodeFixHealth {
  live: boolean;
  keyValid: boolean;
  reposAccessible: boolean;
  missingRepos: string[];
  githubTokenConfigured: boolean;
  checkedAt: string;
  reason: string;
}

let healthCache: { at: number; value: CodeFixHealth } | null = null;

export type CodeFixScope = 'surgical' | 'needs_cursor_approval';
export type CodeFixStatus =
  | 'asking'
  | 'offered'
  | 'dismissed'
  | 'queued'
  | 'running'
  | 'awaiting_cursor_approval'
  | 'pr_open'
  | 'merged'
  | 'failed'
  | 'cancelled';

export interface CodeFixJob {
  id: string;
  orgId?: string;
  requesterUserId?: string;
  requesterName: string;
  requesterRole: string;
  chatSessionId?: string;
  errorCode: string;
  description: string;
  route: string;
  screenshotDataUrl?: string;
  scope: CodeFixScope;
  status: CodeFixStatus;
  attemptCount: number;
  maxAttempts: number;
  lastError?: string;
  alertedAt?: string;
  cursorAgentId?: string;
  cursorAgentUrl?: string;
  prUrl?: string;
  repoUrl?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

let workerStarted = false;
let activeRuns = 0;

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

function readJobs(): CodeFixJob[] {
  try {
    if (!existsSync(STORE_PATH)) return [];
    return JSON.parse(readFileSync(STORE_PATH, 'utf-8')) as CodeFixJob[];
  } catch {
    return [];
  }
}

function writeJobs(jobs: CodeFixJob[]): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(jobs.slice(-2000), null, 2), 'utf-8');
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `cf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * deploy.env resolution order:
 * 1. DEPLOY_ENV_PATH env var (explicit override for standalone/VPS deployments)
 * 2. <repo root>/.cursor/local/deploy.env
 * 3. Dev-only sibling fallback: ../<frontend workspace>/.cursor/local/deploy.env
 */
function resolveDeployEnvCandidates(): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.DEPLOY_ENV_PATH?.trim();
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(join(__dirname, '..', '.cursor', 'local', 'deploy.env'));
  if (process.env.NODE_ENV !== 'production') {
    candidates.push(
      join(__dirname, '..', '..', 'Bathroom Sales Estimation Platform', '.cursor', 'local', 'deploy.env'),
    );
  }
  return candidates;
}

function parseDeployEnv(): Record<string, string> {
  for (const deployPath of resolveDeployEnvCandidates()) {
    try {
      const content = readFileSync(deployPath, 'utf-8');
      const result: Record<string, string> = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      return result;
    } catch {
      // try next candidate
    }
  }
  return {};
}

function resolveCursorApiKey(): string | null {
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromDeploy = parseDeployEnv().CURSOR_API_KEY?.trim();
  return fromDeploy || null;
}

function resolveGithubToken(): string | null {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const fromDeploy = parseDeployEnv().GITHUB_TOKEN?.trim();
  return fromDeploy || null;
}

function cursorAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

function repoSlugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`.toLowerCase();
  } catch {
    // ignore
  }
  return url.toLowerCase();
}

function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function extractPrUrlFromAgent(data: Record<string, unknown>): string | undefined {
  const agent = (data.agent ?? data) as Record<string, unknown>;
  const git = (agent.git ?? data.git ?? {}) as Record<string, unknown>;
  const prs = (git.pullRequests ?? git.prs ?? []) as Array<{ url?: string }>;
  const repos = (agent.repos ?? data.repos ?? []) as Array<{ prUrl?: string; url?: string }>;
  const repoPr = repos.map((r) => r.prUrl).find((u): u is string => Boolean(u));
  return (
    (typeof data.prUrl === 'string' && data.prUrl) ||
    (typeof agent.prUrl === 'string' && agent.prUrl) ||
    prs[0]?.url ||
    repoPr ||
    undefined
  );
}

async function getCursorHealth(force = false): Promise<CodeFixHealth> {
  const now = Date.now();
  if (!force && healthCache && now - healthCache.at < HEALTH_CACHE_MS) {
    return healthCache.value;
  }

  const checkedAt = nowIso();
  const apiKey = resolveCursorApiKey();
  const githubTokenConfigured = Boolean(resolveGithubToken());

  if (!apiKey) {
    const value: CodeFixHealth = {
      live: false,
      keyValid: false,
      reposAccessible: false,
      missingRepos: [...REQUIRED_REPOS],
      githubTokenConfigured,
      checkedAt,
      reason:
        'CURSOR_API_KEY not configured. Add it to server env or .cursor/local/deploy.env.',
    };
    healthCache = { at: now, value };
    return value;
  }

  try {
    const meRes = await fetch('https://api.cursor.com/v1/me', {
      headers: { Authorization: cursorAuthHeader(apiKey) },
    });
    if (!meRes.ok) {
      const value: CodeFixHealth = {
        live: false,
        keyValid: false,
        reposAccessible: false,
        missingRepos: [...REQUIRED_REPOS],
        githubTokenConfigured,
        checkedAt,
        reason: `Cursor API key invalid (GET /v1/me → ${meRes.status}).`,
      };
      healthCache = { at: now, value };
      return value;
    }

    const reposRes = await fetch('https://api.cursor.com/v1/repositories', {
      headers: { Authorization: cursorAuthHeader(apiKey) },
    });
    if (!reposRes.ok) {
      const value: CodeFixHealth = {
        live: false,
        keyValid: true,
        reposAccessible: false,
        missingRepos: [...REQUIRED_REPOS],
        githubTokenConfigured,
        checkedAt,
        reason:
          reposRes.status === 429
            ? 'Cursor repositories endpoint rate-limited — retry shortly.'
            : `Cannot list GitHub repos via Cursor (GET /v1/repositories → ${reposRes.status}).`,
      };
      // Shorter cache on rate limit so we recover faster
      healthCache = { at: now - (reposRes.status === 429 ? HEALTH_CACHE_MS - 60_000 : 0), value };
      return value;
    }

    const reposData = (await reposRes.json().catch(() => ({}))) as Record<string, unknown>;
    const list = (reposData.repositories ?? reposData.repos ?? reposData.items ?? []) as Array<
      string | { url?: string; fullName?: string; full_name?: string; name?: string }
    >;
    const slugs = new Set(
      list.map((r) => {
        if (typeof r === 'string') return repoSlugFromUrl(r);
        const raw = r.fullName || r.full_name || r.url || r.name || '';
        return repoSlugFromUrl(String(raw));
      }),
    );
    const missingRepos = REQUIRED_REPOS.filter((r) => !slugs.has(r));
    const reposAccessible = missingRepos.length === 0;
    const live = reposAccessible;
    const value: CodeFixHealth = {
      live,
      keyValid: true,
      reposAccessible,
      missingRepos: [...missingRepos],
      githubTokenConfigured,
      checkedAt,
      reason: live
        ? githubTokenConfigured
          ? 'LIVE — Cursor API key valid and both TradePro repos accessible. Merges enabled.'
          : 'LIVE — Cursor OK. GITHUB_TOKEN missing — Approve merge will open GitHub for manual merge.'
        : `Cursor key valid but missing repo access: ${missingRepos.join(', ')}. Connect GitHub in Cursor Dashboard.`,
    };
    healthCache = { at: now, value };
    return value;
  } catch (err) {
    const value: CodeFixHealth = {
      live: false,
      keyValid: false,
      reposAccessible: false,
      missingRepos: [...REQUIRED_REPOS],
      githubTokenConfigured,
      checkedAt,
      reason: `Cursor health check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    healthCache = { at: now, value };
    return value;
  }
}

async function mergeGithubPr(prUrl: string): Promise<{
  merged: boolean;
  needsManualMerge?: boolean;
  error?: string;
  sha?: string;
}> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) {
    return { merged: false, needsManualMerge: true, error: 'Invalid GitHub PR URL' };
  }
  const token = resolveGithubToken();
  if (!token) {
    return {
      merged: false,
      needsManualMerge: true,
      error: 'GITHUB_TOKEN not configured. Open the PR on GitHub to merge manually.',
    };
  }
  const res = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/merge`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'TradePro-SelfHeal',
      },
      body: JSON.stringify({
        merge_method: 'squash',
        commit_title: `Self-heal: merge PR #${parsed.number}`,
      }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 200 || data.merged === true) {
    return { merged: true, sha: typeof data.sha === 'string' ? data.sha : undefined };
  }
  if (res.status === 405 || res.status === 409) {
    return {
      merged: false,
      needsManualMerge: true,
      error: typeof data.message === 'string' ? data.message : `GitHub merge ${res.status}`,
    };
  }
  return {
    merged: false,
    needsManualMerge: true,
    error: typeof data.message === 'string' ? data.message : `GitHub API ${res.status}`,
  };
}

async function pollAgentForPr(job: CodeFixJob): Promise<void> {
  if (!job.cursorAgentId || job.prUrl) return;
  const apiKey = resolveCursorApiKey();
  if (!apiKey) return;
  try {
    const res = await fetch(`https://api.cursor.com/v1/agents/${job.cursorAgentId}`, {
      headers: { Authorization: cursorAuthHeader(apiKey) },
    });
    if (!res.ok) return;
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const prUrl = extractPrUrlFromAgent(data);
    if (!prUrl) return;
    upsertJob({
      ...job,
      status: 'pr_open',
      prUrl,
      updatedAt: nowIso(),
      lastError: undefined,
      metadata: { ...job.metadata, prDetectedAt: nowIso() },
    });
  } catch {
    // ignore poll errors
  }
}

function classifyScope(input: {
  errorCode?: string;
  description?: string;
  route?: string;
}): CodeFixScope {
  const text = `${input.errorCode ?? ''} ${input.description ?? ''}`.toLowerCase();
  const redesignHints = [
    'redesign',
    'rebuild',
    'entire app',
    'whole product',
    'every page',
    'all pages',
    'recreate',
    'make it look different',
    'revamp',
  ];
  if (redesignHints.some((h) => text.includes(h))) return 'needs_cursor_approval';
  if (!input.errorCode?.trim() && !/(error|exception|failed|500|404|typeerror|cannot)/i.test(text)) {
    if (/(improve|prettier|modernize|overhaul)/i.test(text)) return 'needs_cursor_approval';
  }
  return 'surgical';
}

/** Gateway / billing / rate-limit — never create Cursor jobs for these. */
function isNonFixableOpsError(errorCode: string, description: string): boolean {
  if (/^HTTP_(429|502|503|504)$/i.test(errorCode.trim())) return true;
  return /no credit|usage limit|billing|quota|insufficient_quota|rate.?limit|openai key rejected|econnreset|econnrefused|etimedout|bad gateway|service unavailable|gateway|upstream|temporarily unavailable|CURSOR_API_KEY not configured/i.test(
    `${errorCode} ${description}`,
  );
}

function pickRepo(route: string, description: string): string {
  const text = `${route} ${description}`.toLowerCase();
  if (
    text.includes('supabase') ||
    text.includes('migration') ||
    text.includes('/api/') ||
    text.includes('backend') ||
    text.includes('server/')
  ) {
    return BACKEND_REPO;
  }
  return FRONTEND_REPO;
}

function upsertJob(job: CodeFixJob): CodeFixJob {
  const jobs = readJobs();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) jobs[idx] = job;
  else jobs.push(job);
  writeJobs(jobs);
  return job;
}

function findJob(id: string): CodeFixJob | undefined {
  return readJobs().find((j) => j.id === id);
}

function findDedupe(errorCode: string, route: string): CodeFixJob | undefined {
  const cutoff = Date.now() - DEDUPE_MS;
  return readJobs().find((j) => {
    if (j.errorCode !== errorCode) return false;
    if (new Date(j.createdAt).getTime() < cutoff) return false;
    if (!OFFER_DEDUPE_STATUSES.includes(j.status)) return false;
    // HTTP class errors: dedupe globally by errorCode (ignore route)
    if (HTTP_CLASS_ERROR_CODES.has(errorCode)) return true;
    // Active pipeline jobs: same errorCode on any route blocks duplicate enqueue
    if (ACTIVE_ENQUEUE_STATUSES.includes(j.status)) return true;
    return j.route === route;
  });
}

function jobAlerts(jobs: CodeFixJob[]) {
  const now = Date.now();
  return jobs.filter((j) => {
    if (j.status === 'failed') return true;
    if (j.status === 'awaiting_cursor_approval') return true;
    if (j.status === 'pr_open') return true;
    if (['queued', 'running'].includes(j.status) && now - new Date(j.updatedAt).getTime() > STUCK_MS) {
      return true;
    }
    return false;
  });
}

function buildAgentPrompt(job: CodeFixJob): string {
  return [
    'You are fixing a production bug for TradePro (bathroom sales / estimation CRM).',
    'SURGICAL FIX ONLY:',
    '- Smallest diff that clears this error.',
    '- Do NOT redesign the product, rewrite every page, or recreate full features.',
    '- Light tweak on one screen is OK if required for this fix.',
    '- If this needs a multi-page redesign, STOP and say Cursor approval is required — do not implement large redesigns.',
    '',
    `Error code: ${job.errorCode || '(none)'}`,
    `Route / page: ${job.route || '(unknown)'}`,
    `Reporter role: ${job.requesterRole}`,
    `Description: ${job.description}`,
    '',
    'Open a PR with a minimal fix. Follow .cursor/BUGBOT.md.',
  ].join('\n');
}

async function launchCursorAgent(job: CodeFixJob): Promise<{
  agentId?: string;
  agentUrl?: string;
  prUrl?: string;
  awaitingApproval?: boolean;
  error?: string;
}> {
  const apiKey = resolveCursorApiKey();
  if (!apiKey) {
    return {
      error:
        'CURSOR_API_KEY not configured. Add it to server env or .cursor/local/deploy.env, then retry.',
    };
  }

  if (job.scope === 'needs_cursor_approval' && !job.metadata.cursorApproved) {
    // Create agent in plan mode so user can approve in Cursor UI
    const res = await fetch('https://api.cursor.com/v1/agents', {
      method: 'POST',
      headers: {
        Authorization: cursorAuthHeader(apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: {
          text: `${buildAgentPrompt(job)}\n\nMODE: Plan only — do not implement until human confirms in Cursor.`,
          images: job.screenshotDataUrl
            ? [{ data: job.screenshotDataUrl.replace(/^data:[^;]+;base64,/, ''), mimeType: 'image/png' }]
            : undefined,
        },
        repos: [{ url: job.repoUrl || FRONTEND_REPO, startingRef: 'master' }],
        autoCreatePR: false,
        mode: 'plan',
        name: `TradePro fix: ${job.errorCode || 'review'}`.slice(0, 100),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { error: `Cursor API ${res.status}: ${JSON.stringify(data).slice(0, 400)}` };
    }
    const agent = (data.agent ?? data) as Record<string, unknown>;
    return {
      agentId: String(agent.id ?? ''),
      agentUrl: String(agent.url ?? `https://cursor.com/agents/${agent.id ?? ''}`),
      awaitingApproval: true,
    };
  }

  const images: Array<{ data: string; mimeType: string }> = [];
  if (job.screenshotDataUrl?.startsWith('data:')) {
    const match = job.screenshotDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      images.push({ mimeType: match[1], data: match[2] });
    }
  }

  const res = await fetch('https://api.cursor.com/v1/agents', {
    method: 'POST',
    headers: {
      Authorization: cursorAuthHeader(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: {
        text: buildAgentPrompt(job),
        ...(images.length ? { images } : {}),
      },
      repos: [{ url: job.repoUrl || FRONTEND_REPO, startingRef: 'master' }],
      autoCreatePR: true,
      mode: 'agent',
      name: `TradePro surgical: ${job.errorCode || 'bug'}`.slice(0, 100),
    }),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return { error: `Cursor API ${res.status}: ${JSON.stringify(data).slice(0, 400)}` };
  }

  const agent = (data.agent ?? data) as Record<string, unknown>;
  const prUrl = extractPrUrlFromAgent(data);

  return {
    agentId: String(agent.id ?? ''),
    agentUrl: String(agent.url ?? `https://cursor.com/agents/${agent.id ?? ''}`),
    prUrl: prUrl || undefined,
  };
}

async function processOneJob(job: CodeFixJob): Promise<void> {
  const running: CodeFixJob = {
    ...job,
    status: 'running',
    attemptCount: job.attemptCount + 1,
    updatedAt: nowIso(),
  };
  upsertJob(running);

  try {
    const result = await launchCursorAgent(running);
    if (result.error) {
      const failed = result.error.includes('rate') || result.error.includes('429') || result.error.includes('network');
      if (failed && running.attemptCount < running.maxAttempts) {
        upsertJob({
          ...running,
          status: 'queued',
          lastError: result.error,
          updatedAt: nowIso(),
          metadata: { ...running.metadata, nextRetryAt: Date.now() + running.attemptCount * 15_000 },
        });
        return;
      }
      upsertJob({
        ...running,
        status: 'failed',
        lastError: result.error,
        alertedAt: nowIso(),
        updatedAt: nowIso(),
      });
      return;
    }

    if (result.awaitingApproval) {
      upsertJob({
        ...running,
        status: 'awaiting_cursor_approval',
        cursorAgentId: result.agentId,
        cursorAgentUrl: result.agentUrl,
        alertedAt: nowIso(),
        updatedAt: nowIso(),
      });
      return;
    }

    upsertJob({
      ...running,
      status: result.prUrl ? 'pr_open' : 'running',
      cursorAgentId: result.agentId,
      cursorAgentUrl: result.agentUrl,
      prUrl: result.prUrl,
      updatedAt: nowIso(),
      lastError: undefined,
      metadata: {
        ...running.metadata,
        ...(result.prUrl ? {} : { launchedAt: nowIso() }),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (running.attemptCount < running.maxAttempts) {
      upsertJob({
        ...running,
        status: 'queued',
        lastError: message,
        updatedAt: nowIso(),
      });
      return;
    }
    upsertJob({
      ...running,
      status: 'failed',
      lastError: message,
      alertedAt: nowIso(),
      updatedAt: nowIso(),
    });
  }
}

async function tickWorker(): Promise<void> {
  // Fill real PR URLs for agents that are still running
  const needingPr = readJobs().filter(
    (j) =>
      (j.status === 'running' || (j.status === 'pr_open' && !j.prUrl)) &&
      Boolean(j.cursorAgentId),
  );
  for (const job of needingPr.slice(0, 5)) {
    void pollAgentForPr(job);
  }

  if (activeRuns >= MAX_CONCURRENCY) return;
  const jobs = readJobs();
  const now = Date.now();
  const next = jobs
    .filter((j) => j.status === 'queued')
    .filter((j) => {
      const nextRetry = Number(j.metadata?.nextRetryAt ?? 0);
      return !nextRetry || nextRetry <= now;
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const slots = MAX_CONCURRENCY - activeRuns;
  for (const job of next.slice(0, slots)) {
    activeRuns += 1;
    void processOneJob(job).finally(() => {
      activeRuns -= 1;
    });
  }
}

export function startCodeFixWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  setInterval(() => {
    void tickWorker();
  }, 5000);
  void tickWorker();
}

function queuePosition(jobId: string): number {
  const queued = readJobs()
    .filter((j) => j.status === 'queued')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const idx = queued.findIndex((j) => j.id === jobId);
  return idx < 0 ? 0 : idx;
}

function allowRole(role: string): boolean {
  return ['super_admin', 'manager', 'staff', 'builder', 'platform_owner'].includes(role);
}

function isAdminRole(role: string): boolean {
  return ['super_admin', 'manager', 'platform_owner'].includes(role);
}

export async function handleCodeFixRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/ai/code-fix')) return false;

  startCodeFixWorker();

  // GET /api/ai/code-fix/health — unauthenticated probe (must run before requireAuth)
  if (req.method === 'GET' && pathname === '/api/ai/code-fix/health') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const force = url.searchParams.get('force') === '1';
    const health = await getCursorHealth(force);
    sendJson(res, 200, health);
    return true;
  }

  if (isAuthEnforced() && !requireAuth(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  // POST /api/ai/code-fix/merge-batch
  if (req.method === 'POST' && pathname === '/api/ai/code-fix/merge-batch') {
    let body: { ids?: string[]; allOpen?: boolean } = {};
    try {
      body = JSON.parse(await readBody(req) || '{}') as { ids?: string[]; allOpen?: boolean };
    } catch {
      body = {};
    }
    const jobs = readJobs();
    const targets = body.allOpen
      ? jobs.filter((j) => j.status === 'pr_open' && Boolean(j.prUrl))
      : (body.ids ?? [])
          .map((id) => jobs.find((j) => j.id === id))
          .filter((j): j is CodeFixJob => Boolean(j && j.status === 'pr_open' && j.prUrl));

    const results: Array<{
      id: string;
      ok: boolean;
      job?: CodeFixJob;
      needsManualMerge?: boolean;
      prUrl?: string;
      error?: string;
    }> = [];

    for (const job of targets) {
      const mergeResult = await mergeGithubPr(job.prUrl!);
      if (mergeResult.merged) {
        const next: CodeFixJob = {
          ...job,
          status: 'merged',
          updatedAt: nowIso(),
          lastError: undefined,
          metadata: { ...job.metadata, mergedAt: nowIso(), mergeSha: mergeResult.sha },
        };
        upsertJob(next);
        results.push({ id: job.id, ok: true, job: next });
      } else {
        results.push({
          id: job.id,
          ok: false,
          needsManualMerge: true,
          prUrl: job.prUrl,
          error: mergeResult.error,
        });
      }
    }

    sendJson(res, 200, {
      results,
      merged: results.filter((r) => r.ok).length,
      needsManual: results.filter((r) => r.needsManualMerge).length,
    });
    return true;
  }

  // GET /api/ai/code-fix
  if (req.method === 'GET' && pathname === '/api/ai/code-fix') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const status = url.searchParams.get('status');
    const search = url.searchParams.get('search')?.toLowerCase();
    let jobs = readJobs().sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    if (status && status !== 'all') jobs = jobs.filter((j) => j.status === status);
    if (search) {
      jobs = jobs.filter((j) =>
        `${j.errorCode} ${j.description} ${j.requesterName} ${j.route} ${j.lastError ?? ''}`
          .toLowerCase()
          .includes(search),
      );
    }
    const alerts = jobAlerts(jobs);
    const queueDepth = jobs.filter((j) => j.status === 'queued').length;
    const health = await getCursorHealth();
    sendJson(res, 200, {
      jobs,
      alerts,
      queueDepth,
      activeRuns,
      cursorConfigured: health.keyValid,
      health,
    });
    return true;
  }

  // GET /api/ai/code-fix/:id
  const detailMatch = pathname.match(/^\/api\/ai\/code-fix\/([^/]+)$/);
  if (req.method === 'GET' && detailMatch) {
    const job = findJob(detailMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: 'Job not found' });
      return true;
    }
    sendJson(res, 200, {
      job,
      queuePosition: queuePosition(job.id),
      alerts: jobAlerts([job]),
    });
    return true;
  }

  // POST /api/ai/code-fix/:id/merge
  const mergeMatch = pathname.match(/^\/api\/ai\/code-fix\/([^/]+)\/merge$/);
  if (req.method === 'POST' && mergeMatch) {
    const job = findJob(mergeMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: 'Job not found' });
      return true;
    }
    if (job.status !== 'pr_open') {
      sendJson(res, 400, { error: `Cannot merge job in status ${job.status}` });
      return true;
    }
    if (!job.prUrl || !parsePrUrl(job.prUrl)) {
      sendJson(res, 400, {
        error: 'No GitHub PR URL yet — wait for the agent to open a PR, or merge via Cursor agent link.',
        needsManualMerge: true,
        cursorAgentUrl: job.cursorAgentUrl,
      });
      return true;
    }
    const mergeResult = await mergeGithubPr(job.prUrl);
    if (mergeResult.merged) {
      const next: CodeFixJob = {
        ...job,
        status: 'merged',
        updatedAt: nowIso(),
        lastError: undefined,
        metadata: { ...job.metadata, mergedAt: nowIso(), mergeSha: mergeResult.sha },
      };
      upsertJob(next);
      sendJson(res, 200, { job: next, merged: true });
      return true;
    }
    sendJson(res, 200, {
      job,
      merged: false,
      needsManualMerge: true,
      prUrl: job.prUrl,
      error: mergeResult.error,
    });
    return true;
  }

  // POST /api/ai/code-fix/:id/retry
  const retryMatch = pathname.match(/^\/api\/ai\/code-fix\/([^/]+)\/retry$/);
  if (req.method === 'POST' && retryMatch) {
    const job = findJob(retryMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: 'Job not found' });
      return true;
    }
    if (!['failed', 'cancelled', 'awaiting_cursor_approval'].includes(job.status)) {
      sendJson(res, 400, { error: `Cannot retry job in status ${job.status}` });
      return true;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
    } catch {
      body = {};
    }
    const next: CodeFixJob = {
      ...job,
      status: 'queued',
      lastError: undefined,
      alertedAt: undefined,
      updatedAt: nowIso(),
      metadata: {
        ...job.metadata,
        ...(body.cursorApproved ? { cursorApproved: true } : {}),
        retriedAt: nowIso(),
      },
      scope: body.cursorApproved ? 'surgical' : job.scope,
    };
    upsertJob(next);
    void tickWorker();
    sendJson(res, 200, { job: next, queuePosition: queuePosition(next.id) });
    return true;
  }

  // POST /api/ai/code-fix/:id/dismiss
  const dismissMatch = pathname.match(/^\/api\/ai\/code-fix\/([^/]+)\/dismiss$/);
  if (req.method === 'POST' && dismissMatch) {
    const job = findJob(dismissMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: 'Job not found' });
      return true;
    }
    const next = { ...job, status: 'dismissed' as const, updatedAt: nowIso() };
    upsertJob(next);
    sendJson(res, 200, { job: next });
    return true;
  }

  // POST /api/ai/code-fix/:id/status (manual mark merged/cancelled)
  const statusMatch = pathname.match(/^\/api\/ai\/code-fix\/([^/]+)\/status$/);
  if (req.method === 'POST' && statusMatch) {
    const job = findJob(statusMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: 'Job not found' });
      return true;
    }
    let body: { status?: CodeFixStatus; prUrl?: string } = {};
    try {
      body = JSON.parse(await readBody(req) || '{}') as { status?: CodeFixStatus; prUrl?: string };
    } catch {
      body = {};
    }
    if (!body.status || !['merged', 'cancelled', 'pr_open', 'failed'].includes(body.status)) {
      sendJson(res, 400, { error: 'Invalid status' });
      return true;
    }
    const next: CodeFixJob = {
      ...job,
      status: body.status,
      prUrl: body.prUrl ?? job.prUrl,
      updatedAt: nowIso(),
    };
    upsertJob(next);
    sendJson(res, 200, { job: next });
    return true;
  }

  // POST /api/ai/code-fix — create / offer / enqueue
  if (req.method === 'POST' && pathname === '/api/ai/code-fix') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }

    const role = String(body.requesterRole ?? body.role ?? 'unknown');
    if (!allowRole(role)) {
      sendJson(res, 403, { error: 'Role not allowed to request code fixes' });
      return true;
    }

    const action = String(body.action ?? 'enqueue'); // offer | enqueue | dismiss_offer
    const errorCode = String(body.errorCode ?? '').trim();
    const description = String(body.description ?? body.message ?? '').trim();
    const route = String(body.route ?? '').trim();
    const orgId = resolveOrgIdForRequest(req, body as { orgId?: string }) ?? undefined;

    if (isNonFixableOpsError(errorCode, description)) {
      sendJson(res, 200, {
        skipped: true,
        reason: 'ops_infra',
        message:
          'This is an ops/infra or billing failure (not an application code defect). No Cursor fix was created.',
        errorCode,
      });
      return true;
    }

    if (action === 'offer') {
      const existing = errorCode ? findDedupe(errorCode, route) : undefined;
      if (existing) {
        sendJson(res, 200, {
          job: existing,
          dedupe: true,
          message: existing.status === 'offered'
            ? 'Already asked about this error recently.'
            : 'Already being worked on.',
        });
        return true;
      }
      const job: CodeFixJob = {
        id: newId(),
        orgId,
        requesterUserId: body.requesterUserId ? String(body.requesterUserId) : undefined,
        requesterName: String(body.requesterName ?? 'Staff'),
        requesterRole: role,
        chatSessionId: body.chatSessionId ? String(body.chatSessionId) : undefined,
        errorCode,
        description: description || 'Application error detected',
        route,
        screenshotDataUrl: body.screenshotDataUrl ? String(body.screenshotDataUrl) : undefined,
        scope: classifyScope({ errorCode, description, route }),
        status: 'offered',
        attemptCount: 0,
        maxAttempts: MAX_ATTEMPTS,
        repoUrl: pickRepo(route, description),
        metadata: { ...(body.metadata as object || {}) },
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      upsertJob(job);
      sendJson(res, 201, { job, dedupe: false });
      return true;
    }

    if (!errorCode && !description) {
      sendJson(res, 400, {
        error: 'errorCode or description required',
        code: 'missing_details',
        status: 'asking',
      });
      return true;
    }

    const offeredId = body.jobId ? String(body.jobId) : undefined;
    let base = offeredId ? findJob(offeredId) : undefined;

    if (!base && errorCode) {
      const existing = findDedupe(errorCode, route);
      if (existing && ['queued', 'running', 'pr_open', 'awaiting_cursor_approval'].includes(existing.status)) {
        sendJson(res, 200, {
          job: existing,
          dedupe: true,
          queuePosition: queuePosition(existing.id),
          message: 'Already being worked on.',
        });
        return true;
      }
      if (existing?.status === 'offered') base = existing;
    }

    const scope = classifyScope({
      errorCode: errorCode || base?.errorCode,
      description: description || base?.description,
      route: route || base?.route,
    });

    const job: CodeFixJob = {
      id: base?.id ?? newId(),
      orgId: orgId ?? base?.orgId,
      requesterUserId: body.requesterUserId
        ? String(body.requesterUserId)
        : base?.requesterUserId,
      requesterName: String(body.requesterName ?? base?.requesterName ?? 'Staff'),
      requesterRole: role,
      chatSessionId: body.chatSessionId
        ? String(body.chatSessionId)
        : base?.chatSessionId,
      errorCode: errorCode || base?.errorCode || '',
      description: description || base?.description || '',
      route: route || base?.route || '',
      screenshotDataUrl: body.screenshotDataUrl
        ? String(body.screenshotDataUrl)
        : base?.screenshotDataUrl,
      scope,
      status: scope === 'needs_cursor_approval' ? 'awaiting_cursor_approval' : 'queued',
      attemptCount: base?.attemptCount ?? 0,
      maxAttempts: MAX_ATTEMPTS,
      repoUrl: pickRepo(route || base?.route || '', description || base?.description || ''),
      metadata: { ...(base?.metadata || {}), confirmedAt: nowIso() },
      createdAt: base?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      cursorAgentId: base?.cursorAgentId,
      cursorAgentUrl: base?.cursorAgentUrl,
      prUrl: base?.prUrl,
      lastError: undefined,
      alertedAt: scope === 'needs_cursor_approval' ? nowIso() : undefined,
    };

    upsertJob(job);

    if (job.status === 'queued') {
      void tickWorker();
    } else if (job.status === 'awaiting_cursor_approval') {
      // Still create a plan-mode agent so user has a Cursor link
      void processOneJob({ ...job, status: 'queued', scope: 'needs_cursor_approval' });
    }

    sendJson(res, 201, {
      job,
      queuePosition: queuePosition(job.id),
      needsCursorApproval: job.scope === 'needs_cursor_approval',
      message:
        job.scope === 'needs_cursor_approval'
          ? 'This looks larger than a surgical fix — approve in Cursor before implementation.'
          : 'Logged — in the fix queue.',
    });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}

// Suppress unused warning for admin helper (available for future auth tightening)
void isAdminRole;
