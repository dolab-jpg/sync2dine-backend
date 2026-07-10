import type { IncomingMessage, ServerResponse } from 'http';

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

interface BankingAdapter {
  listAccounts(): Promise<BankAccountDto[]>;
  listTransactions(accountId?: string): Promise<BankTransactionDto[]>;
  connect(config: Record<string, string>): Promise<{ authUrl?: string; message: string }>;
}

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
  async listTransactions(accountId) {
    return accountId ? mockTransactions.filter((t) => t.accountId === accountId) : mockTransactions;
  },
  async connect() {
    return { message: 'Mock bank feed connected. Set provider to TrueLayer, GoCardless, or Plaid in Integrations for live Open Banking.' };
  },
};

function stubAdapter(name: string): BankingAdapter {
  return {
    async listAccounts() {
      return mockAccounts.map((a) => ({ ...a, provider: 'mock' as BankingProviderId, name: `${a.name} (${name} stub)` }));
    },
    async listTransactions(accountId) {
      return mockAdapter.listTransactions(accountId);
    },
    async connect(config) {
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
      return stubAdapter('TrueLayer');
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

  if (pathname === '/api/banking/accounts' && req.method === 'GET') {
    const provider = url.searchParams.get('provider') || 'mock';
    const accounts = await getAdapter(provider).listAccounts();
    sendJson(res, 200, { accounts, provider });
    return true;
  }

  if (pathname === '/api/banking/transactions' && req.method === 'GET') {
    const provider = url.searchParams.get('provider') || 'mock';
    const accountId = url.searchParams.get('accountId') || undefined;
    const transactions = await getAdapter(provider).listTransactions(accountId);
    sendJson(res, 200, { transactions, provider });
    return true;
  }

  if (pathname === '/api/banking/connect' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as Record<string, string>;
    const provider = body.provider || 'mock';
    const result = await getAdapter(provider).connect(body);
    sendJson(res, 200, {
      success: true,
      provider,
      authUrl: result.authUrl,
      message: result.message,
    });
    return true;
  }

  if (pathname === '/api/banking/callback' && req.method === 'GET') {
    sendJson(res, 200, {
      success: true,
      message: 'Bank connection callback received. Tokens would be stored server-side in production.',
    });
    return true;
  }

  sendJson(res, 404, { error: 'Banking route not found' });
  return true;
}
