import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type BankingProviderId = 'mock' | 'truelayer' | 'gocardless' | 'plaid';

export interface BankAccountDto {
  id: string;
  name: string;
  sortCode: string;
  accountNumberMasked: string;
  ibanMasked?: string;
  balance: number;
  currency: string;
  provider: BankingProviderId;
  connectedAt: string;
  lastSyncedAt?: string;
}

export interface BankTransactionDto {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  direction: 'in' | 'out';
  description: string;
  category: string;
  reconciled: boolean;
  createdAt: string;
}

interface BankingTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface BankingAdapter {
  listAccounts(orgId: string): Promise<BankAccountDto[]>;
  listTransactions(orgId: string, accountId?: string): Promise<BankTransactionDto[]>;
  connect(orgId: string, config: Record<string, string>): Promise<{ authUrl?: string; message: string }>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = join(__dirname, 'data', 'banking-tokens.json');
const tokenMemory = new Map<string, BankingTokens>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getOrgId(req: IncomingMessage, url: URL): string {
  const header = req.headers['x-org-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return url.searchParams.get('orgId') || 'default';
}

function loadTokensFromDisk(): void {
  try {
    if (!existsSync(TOKENS_FILE)) return;
    const raw = readFileSync(TOKENS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, BankingTokens>;
    for (const [orgId, tokens] of Object.entries(parsed)) {
      tokenMemory.set(orgId, tokens);
    }
  } catch {
    // ignore corrupt file
  }
}

function saveTokensToDisk(): void {
  try {
    mkdirSync(dirname(TOKENS_FILE), { recursive: true });
    const obj: Record<string, BankingTokens> = {};
    for (const [orgId, tokens] of tokenMemory.entries()) {
      obj[orgId] = tokens;
    }
    writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.warn('[banking] Failed to persist tokens:', err);
  }
}

function getTokens(orgId: string): BankingTokens | undefined {
  if (tokenMemory.size === 0) loadTokensFromDisk();
  return tokenMemory.get(orgId);
}

function setTokens(orgId: string, tokens: BankingTokens): void {
  tokenMemory.set(orgId, tokens);
  saveTokensToDisk();
}

loadTokensFromDisk();

const mockAccounts: BankAccountDto[] = [
  {
    id: 'BA001',
    name: 'TradePro Business Current',
    sortCode: '20-00-00',
    accountNumberMasked: '****4521',
    ibanMasked: 'GB** **** **** **** 4521',
    balance: 42850.75,
    currency: 'GBP',
    provider: 'mock',
    connectedAt: new Date().toISOString(),
    lastSyncedAt: new Date().toISOString(),
  },
  {
    id: 'BA002',
    name: 'TradePro Materials Float',
    sortCode: '20-00-00',
    accountNumberMasked: '****8834',
    balance: 12400.0,
    currency: 'GBP',
    provider: 'mock',
    connectedAt: new Date().toISOString(),
    lastSyncedAt: new Date().toISOString(),
  },
];

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

const mockTransactions: BankTransactionDto[] = [
  { id: 'TX001', accountId: 'BA001', date: daysAgo(2), amount: 840, direction: 'in', description: 'FASTER PAYMENT - AMANDA PETERSON', category: 'deposit', reconciled: true, createdAt: new Date().toISOString() },
  { id: 'TX002', accountId: 'BA001', date: daysAgo(5), amount: 5600, direction: 'in', description: 'BACS - JAMES WILSON REF INV001', category: 'stage-payment', reconciled: true, createdAt: new Date().toISOString() },
  { id: 'TX003', accountId: 'BA002', date: daysAgo(3), amount: 312.58, direction: 'out', description: 'TOPPS TILES LTD', category: 'materials', reconciled: true, createdAt: new Date().toISOString() },
  { id: 'TX004', accountId: 'BA001', date: daysAgo(1), amount: 1850, direction: 'out', description: 'MIKE WILSON BUILDERS LTD', category: 'subcontractor', reconciled: false, createdAt: new Date().toISOString() },
  { id: 'TX005', accountId: 'BA001', date: daysAgo(0), amount: 450, direction: 'out', description: 'SHELL FUEL CARD', category: 'fuel', reconciled: false, createdAt: new Date().toISOString() },
  { id: 'TX006', accountId: 'BA001', date: daysAgo(7), amount: 320, direction: 'out', description: 'O2 BUSINESS MOBILE', category: 'running-costs', reconciled: true, createdAt: new Date().toISOString() },
  { id: 'TX007', accountId: 'BA001', date: daysAgo(4), amount: 2200, direction: 'in', description: 'FASTER PAYMENT - SARAH CHEN', category: 'uncategorised', reconciled: false, createdAt: new Date().toISOString() },
];

const mockAdapter: BankingAdapter = {
  async listAccounts() {
    return mockAccounts;
  },
  async listTransactions(_orgId, accountId) {
    return accountId ? mockTransactions.filter((t) => t.accountId === accountId) : mockTransactions;
  },
  async connect() {
    return { message: 'Mock bank feed connected. Set provider to TrueLayer, GoCardless, or Plaid in Integrations for live Open Banking.' };
  },
};

function maskAccountNumber(num?: string): string {
  if (!num) return '****';
  return `****${num.slice(-4)}`;
}

function formatSortCode(provider?: { sort_code?: string }): string {
  const sc = provider?.sort_code ?? '';
  if (sc.length === 6) return `${sc.slice(0, 2)}-${sc.slice(2, 4)}-${sc.slice(4, 6)}`;
  return sc || '—';
}

async function exchangeTrueLayerCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<BankingTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetch('https://auth.truelayer-sandbox.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`TrueLayer token exchange failed: ${errText}`);
  }
  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

const truelayerAdapter: BankingAdapter = {
  async connect(orgId, config) {
    const clientId = config.clientId?.trim();
    const clientSecret = config.clientSecret?.trim();
    if (!clientId || !clientSecret) {
      return { message: 'TrueLayer: configure Client ID and Client Secret in Integrations Hub, then reconnect.' };
    }
    const redirectUri = config.redirectUri?.trim() || 'http://localhost:3001/api/banking/callback';
    const scope = encodeURIComponent('info accounts balance transactions');
    const authUrl =
      `https://auth.truelayer-sandbox.com/?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&scope=${scope}&redirect_uri=${encodeURIComponent(redirectUri)}&providers=uk-ob-all` +
      `&state=${encodeURIComponent(orgId)}`;
    return {
      authUrl,
      message: 'TrueLayer OAuth initiated — complete authorisation in your bank app.',
    };
  },

  async listAccounts(orgId) {
    const tokens = getTokens(orgId);
    if (!tokens?.accessToken) {
      return mockAccounts.map((a) => ({
        ...a,
        name: `${a.name} (TrueLayer — not connected)`,
        provider: 'truelayer' as BankingProviderId,
      }));
    }

    const res = await fetch('https://api.truelayer-sandbox.com/data/v1/accounts', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`TrueLayer accounts fetch failed: ${await res.text()}`);
    }
    const data = await res.json() as {
      results?: Array<{
        account_id: string;
        display_name?: string;
        currency?: string;
        account_type?: string;
        provider?: { display_name?: string; sort_code?: string; account_number?: string };
      }>;
    };
    const now = new Date().toISOString();
    return (data.results ?? []).map((acc) => ({
      id: acc.account_id,
      name: acc.display_name || acc.provider?.display_name || 'Bank account',
      sortCode: formatSortCode(acc.provider),
      accountNumberMasked: maskAccountNumber(acc.provider?.account_number),
      balance: 0,
      currency: acc.currency || 'GBP',
      provider: 'truelayer' as BankingProviderId,
      connectedAt: now,
      lastSyncedAt: now,
    }));
  },

  async listTransactions(orgId, accountId) {
    const tokens = getTokens(orgId);
    if (!tokens?.accessToken) {
      return mockAdapter.listTransactions(orgId, accountId);
    }

    const accounts = await truelayerAdapter.listAccounts(orgId);
    const targetIds = accountId ? [accountId] : accounts.map((a) => a.id);
    const all: BankTransactionDto[] = [];

    for (const id of targetIds) {
      const res = await fetch(`https://api.truelayer-sandbox.com/data/v1/accounts/${encodeURIComponent(id)}/transactions`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (!res.ok) continue;
      const data = await res.json() as {
        results?: Array<{
          transaction_id: string;
          timestamp: string;
          amount: number;
          currency?: string;
          description?: string;
        }>;
      };
      for (const tx of data.results ?? []) {
        all.push({
          id: tx.transaction_id,
          accountId: id,
          date: tx.timestamp.split('T')[0],
          amount: Math.abs(tx.amount),
          direction: tx.amount >= 0 ? 'in' : 'out',
          description: tx.description || 'Transaction',
          category: 'uncategorised',
          reconciled: false,
          createdAt: tx.timestamp,
        });
      }
    }
    return all.sort((a, b) => b.date.localeCompare(a.date));
  },
};

function stubAdapter(name: string): BankingAdapter {
  return {
    async listAccounts(_orgId) {
      return mockAccounts.map((a) => ({ ...a, provider: 'mock' as BankingProviderId, name: `${a.name} (${name} stub)` }));
    },
    async listTransactions(orgId, accountId) {
      return mockAdapter.listTransactions(orgId, accountId);
    },
    async connect(_orgId, config) {
      const clientId = config.clientId?.trim();
      if (!clientId) {
        return { message: `${name}: configure Client ID and Client Secret in Integrations Hub, then reconnect.` };
      }
      const redirectUri = config.redirectUri || 'http://localhost:5173/integrations';
      return {
        authUrl: `https://auth.${name.toLowerCase()}.example/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
        message: `${name} OAuth initiated — complete authorisation in your bank app.`,
      };
    },
  };
}

function getAdapter(provider: string): BankingAdapter {
  switch (provider) {
    case 'truelayer':
      return truelayerAdapter;
    case 'gocardless':
      return stubAdapter('GoCardless');
    case 'plaid':
      return stubAdapter('Plaid');
    default:
      return mockAdapter;
  }
}

export async function handleBankingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL
): Promise<boolean> {
  if (!pathname.startsWith('/api/banking/')) return false;

  const orgId = getOrgId(req, url);

  if (pathname === '/api/banking/accounts' && req.method === 'GET') {
    const provider = url.searchParams.get('provider') || 'mock';
    try {
      const accounts = await getAdapter(provider).listAccounts(orgId);
      sendJson(res, 200, { accounts, provider, connected: provider === 'truelayer' ? Boolean(getTokens(orgId)) : provider === 'mock' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Failed to fetch accounts' });
    }
    return true;
  }

  if (pathname === '/api/banking/transactions' && req.method === 'GET') {
    const provider = url.searchParams.get('provider') || 'mock';
    const accountId = url.searchParams.get('accountId') || undefined;
    try {
      const transactions = await getAdapter(provider).listTransactions(orgId, accountId);
      sendJson(res, 200, { transactions, provider });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Failed to fetch transactions' });
    }
    return true;
  }

  if (pathname === '/api/banking/connect' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as Record<string, string>;
    const provider = body.provider || 'mock';
    const result = await getAdapter(provider).connect(orgId, body);
    sendJson(res, 200, {
      success: true,
      provider,
      authUrl: result.authUrl,
      message: result.message,
    });
    return true;
  }

  if (pathname === '/api/banking/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || orgId;
    const clientId = process.env.TRUELAYER_CLIENT_ID?.trim() || url.searchParams.get('client_id') || '';
    const clientSecret = process.env.TRUELAYER_CLIENT_SECRET?.trim() || '';
    const redirectUri = process.env.TRUELAYER_REDIRECT_URI?.trim() || 'http://localhost:3001/api/banking/callback';

    if (!code) {
      sendJson(res, 400, { success: false, error: 'Missing authorization code' });
      return true;
    }
    if (!clientId || !clientSecret) {
      sendJson(res, 400, {
        success: false,
        error: 'TrueLayer client credentials not configured on server (TRUELAYER_CLIENT_ID / TRUELAYER_CLIENT_SECRET).',
      });
      return true;
    }
    try {
      const tokens = await exchangeTrueLayerCode(code, clientId, clientSecret, redirectUri);
      setTokens(state, tokens);
      sendJson(res, 200, {
        success: true,
        message: 'Bank connection established via TrueLayer. You can close this window and sync accounts.',
        orgId: state,
      });
    } catch (err) {
      sendJson(res, 500, {
        success: false,
        error: err instanceof Error ? err.message : 'Token exchange failed',
      });
    }
    return true;
  }

  if (pathname === '/api/banking/status' && req.method === 'GET') {
    const provider = url.searchParams.get('provider') || 'mock';
    sendJson(res, 200, {
      provider,
      connected: provider === 'truelayer' ? Boolean(getTokens(orgId)) : provider === 'mock',
    });
    return true;
  }

  sendJson(res, 404, { error: 'Banking route not found' });
  return true;
}
