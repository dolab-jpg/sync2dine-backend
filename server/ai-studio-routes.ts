import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_PATH = join(__dirname, 'data', 'ai-studio.json');
const RETENTION_PATH = join(__dirname, 'data', 'ai-studio-meta.json');

interface StudioMeta {
  conversationRetentionDays: number;
  auditRoles: string[];
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

function readStudioConfig(): Record<string, unknown> | null {
  try {
    if (!existsSync(STUDIO_PATH)) return null;
    return JSON.parse(readFileSync(STUDIO_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeStudioConfig(config: Record<string, unknown>): void {
  mkdirSync(dirname(STUDIO_PATH), { recursive: true });
  writeFileSync(STUDIO_PATH, JSON.stringify(config, null, 2));
}

export function readStudioMeta(): StudioMeta {
  try {
    if (!existsSync(RETENTION_PATH)) {
      return { conversationRetentionDays: 365, auditRoles: ['super_admin', 'manager'] };
    }
    return JSON.parse(readFileSync(RETENTION_PATH, 'utf-8')) as StudioMeta;
  } catch {
    return { conversationRetentionDays: 365, auditRoles: ['super_admin', 'manager'] };
  }
}

function writeStudioMeta(meta: StudioMeta): void {
  mkdirSync(dirname(RETENTION_PATH), { recursive: true });
  writeFileSync(RETENTION_PATH, JSON.stringify(meta, null, 2));
}

async function syncStudioToMongo(
  connectionString: string,
  config: Record<string, unknown>,
  databaseName?: string
): Promise<void> {
  const { MongoClient } = await import('mongodb');
  const { resolveDatabaseName } = await import('./mongodb');
  const client = new MongoClient(connectionString.trim(), { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const dbName = databaseName?.trim() || resolveDatabaseName(connectionString);
    const db = client.db(dbName);
    await db.collection('ai_studio_config').updateOne(
      { _id: 'default' },
      { $set: { ...config, updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function handleAIStudioRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith('/api/ai/studio')) return false;

  if (req.method === 'GET' && pathname === '/api/ai/studio') {
    const config = readStudioConfig();
    sendJson(res, 200, { config, meta: readStudioMeta() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/ai/studio') {
    const body = JSON.parse(await readBody(req));
    const config = body.config as Record<string, unknown>;
    if (!config || typeof config !== 'object') {
      sendJson(res, 400, { error: 'config required' });
      return true;
    }
    writeStudioConfig(config);
    if (typeof config.conversationRetentionDays === 'number') {
      writeStudioMeta({
        conversationRetentionDays: config.conversationRetentionDays,
        auditRoles: Array.isArray(config.auditRoles) ? config.auditRoles : readStudioMeta().auditRoles,
      });
    }
    const mongoUri = body.mongodb?.connectionString || process.env.MONGODB_CONNECTION_STRING;
    if (mongoUri?.trim()) {
      try {
        await syncStudioToMongo(mongoUri, config, body.mongodb?.databaseName);
      } catch {
        // Mongo optional
      }
    }
    sendJson(res, 200, { ok: true, mongodb: Boolean(mongoUri?.trim()) });
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
