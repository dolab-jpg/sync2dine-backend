import type { IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';
import { getDataStore, syncData } from './data-store';

interface ServerContract {
  id: string;
  customerId: string;
  customerName: string;
  quoteId?: string;
  templateId?: string;
  tradeName?: string;
  total: number;
  depositAmount: number;
  stages: Array<{
    label: string;
    description: string;
    percent: number;
    amount: number;
    dueTrigger: string;
    status?: 'pending' | 'due' | 'paid';
  }>;
  bodyRendered: string;
  status: 'draft' | 'sent' | 'signed';
  createdAt: string;
  sentAt?: string;
  signToken?: string;
  signTokenExpiresAt?: string;
  signedAt?: string;
  signedByName?: string;
  signatureDataUrl?: string;
  signerIpHash?: string;
  contentHashAtSigning?: string;
  depositDue?: boolean;
  events?: Array<{ at: string; action: string; note?: string }>;
}

function hashContent(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function hashIp(ip: string): string {
  return createHash('sha256').update(ip + (process.env.SIGNING_SALT ?? 'tradepro')).digest('hex').slice(0, 16);
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getContracts(): ServerContract[] {
  const store = getDataStore();
  return (store.contracts ?? []) as unknown as ServerContract[];
}

function saveContracts(contracts: ServerContract[]): void {
  syncData({ contracts: contracts as unknown as Record<string, unknown>[] });
}

function findByToken(token: string): ServerContract | undefined {
  return getContracts().find((c) => c.signToken === token);
}

function markDepositDueOnProject(quoteId: string | undefined): void {
  if (!quoteId) return;
  const store = getDataStore();
  const projects = store.projects.map((p) => {
    if (p.quoteId !== quoteId) return p;
    const stages = Array.isArray(p.paymentStages) ? [...(p.paymentStages as Array<Record<string, unknown>>)] : [];
    if (stages.length > 0 && stages[0].status === 'pending') {
      stages[0] = { ...stages[0], status: 'due', dueDate: new Date().toISOString().slice(0, 10) };
    }
    return { ...p, paymentStages: stages };
  });
  syncData({ projects });
}

function toPublicView(c: ServerContract) {
  return {
    customerName: c.customerName,
    tradeName: c.tradeName,
    total: c.total,
    depositAmount: c.depositAmount,
    stages: c.stages,
    bodyRendered: c.bodyRendered,
    status: c.status,
    signTokenExpiresAt: c.signTokenExpiresAt,
    signedAt: c.signedAt,
  };
}

export async function handleContractRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname === '/api/contracts' && req.method === 'GET') {
    json(res, 200, { contracts: getContracts() });
    return true;
  }

  if (pathname === '/api/contracts/sync' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const { contract } = JSON.parse(raw) as { contract?: ServerContract };
      if (!contract?.id || !contract.signToken) {
        json(res, 400, { error: 'contract with id and signToken required' });
        return true;
      }
      const contracts = getContracts();
      const idx = contracts.findIndex((c) => c.id === contract.id);
      const withEvent: ServerContract = {
        ...contract,
        events: [
          ...(contract.events ?? contracts[idx]?.events ?? []),
          { at: new Date().toISOString(), action: 'sent', note: 'Synced for customer signing' },
        ],
      };
      if (idx >= 0) contracts[idx] = { ...contracts[idx], ...withEvent };
      else contracts.unshift(withEvent);
      saveContracts(contracts);
      json(res, 200, { success: true });
    } catch {
      json(res, 400, { error: 'Invalid request body' });
    }
    return true;
  }

  const tokenMatch = pathname.match(/^\/api\/contract\/([^/]+)(\/sign)?$/);
  if (!tokenMatch) return false;

  const token = decodeURIComponent(tokenMatch[1]);
  const isSign = Boolean(tokenMatch[2]);

  if (!isSign && req.method === 'GET') {
    const contract = findByToken(token);
    if (!contract) {
      json(res, 404, { error: 'Contract not found' });
      return true;
    }
    if (contract.signTokenExpiresAt && new Date(contract.signTokenExpiresAt) < new Date()) {
      json(res, 410, { error: 'This signing link has expired' });
      return true;
    }
    if (contract.status !== 'signed') {
      const contracts = getContracts();
      const idx = contracts.findIndex((c) => c.signToken === token);
      if (idx >= 0) {
        contracts[idx] = {
          ...contracts[idx],
          events: [
            ...(contracts[idx].events ?? []),
            { at: new Date().toISOString(), action: 'viewed' },
          ],
        };
        saveContracts(contracts);
      }
    }
    json(res, 200, toPublicView(contract));
    return true;
  }

  if (isSign && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as {
        signedByName?: string;
        signatureDataUrl?: string;
        agreed?: boolean;
      };

      if (!body.agreed) {
        json(res, 400, { error: 'You must agree to the terms' });
        return true;
      }
      if (!body.signedByName?.trim()) {
        json(res, 400, { error: 'Name is required' });
        return true;
      }
      if (!body.signatureDataUrl?.startsWith('data:image/')) {
        json(res, 400, { error: 'Valid signature is required' });
        return true;
      }

      const contracts = getContracts();
      const idx = contracts.findIndex((c) => c.signToken === token);
      if (idx < 0) {
        json(res, 404, { error: 'Contract not found' });
        return true;
      }

      const contract = contracts[idx];
      if (contract.signTokenExpiresAt && new Date(contract.signTokenExpiresAt) < new Date()) {
        json(res, 410, { error: 'This signing link has expired' });
        return true;
      }
      if (contract.status !== 'sent') {
        json(res, 400, { error: contract.status === 'signed' ? 'Contract already signed' : 'Contract not ready for signing' });
        return true;
      }

      const contentHash = hashContent(contract.bodyRendered);
      const signedAt = new Date().toISOString();
      const updatedStages = contract.stages.map((s, i) =>
        i === 0 ? { ...s, status: 'due' as const } : s
      );

      contracts[idx] = {
        ...contract,
        status: 'signed',
        signedAt,
        signedByName: body.signedByName.trim(),
        signatureDataUrl: body.signatureDataUrl,
        signerIpHash: hashIp(getClientIp(req)),
        contentHashAtSigning: contentHash,
        depositDue: true,
        stages: updatedStages,
        events: [
          ...(contract.events ?? []),
          { at: signedAt, action: 'signed', note: `Signed by ${body.signedByName.trim()}` },
        ],
      };

      saveContracts(contracts);
      markDepositDueOnProject(contract.quoteId);
      json(res, 200, {
        success: true,
        signedAt,
        depositAmount: contract.depositAmount,
      });
    } catch {
      json(res, 400, { error: 'Invalid request body' });
    }
    return true;
  }

  return false;
}
