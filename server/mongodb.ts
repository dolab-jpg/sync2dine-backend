import { MongoClient, type Db } from 'mongodb';
import type { SyncedData } from './data-store';

const COLLECTION = 'app_data';
const LEGACY_DOC_ID = 'synced';

function docIdForOrg(orgId?: string): string {
  const id = orgId?.trim();
  if (!id || id === 'default') return LEGACY_DOC_ID;
  return `org_${id}`;
}

export function resolveDatabaseName(connectionString: string, fallback = 'tradepro'): string {
  try {
    const url = new URL(connectionString.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://'));
    const path = url.pathname.replace(/^\//, '').split('/')[0];
    if (path) return path;
  } catch {
    // ignore parse errors
  }
  return fallback;
}

export async function testMongoConnection(
  connectionString: string,
  databaseName?: string
): Promise<{ ok: true; database: string; collections: string[] } | { ok: false; error: string }> {
  const uri = connectionString.trim();
  if (!uri) {
    return { ok: false, error: 'Connection string is required' };
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const dbName = databaseName?.trim() || resolveDatabaseName(uri);
    const db = client.db(dbName);
    await db.command({ ping: 1 });
    const collections = await db.listCollections().toArray();
    return {
      ok: true,
      database: dbName,
      collections: collections.map(c => c.name),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'MongoDB connection failed',
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function saveSyncedDataToMongo(
  connectionString: string,
  data: SyncedData,
  databaseName?: string,
  orgId?: string,
): Promise<void> {
  const client = new MongoClient(connectionString.trim(), { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const dbName = databaseName?.trim() || resolveDatabaseName(connectionString);
    const db = client.db(dbName);
    await db.collection(COLLECTION).updateOne(
      { _id: docIdForOrg(orgId) },
      {
        $set: {
          ...data,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true }
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function loadSyncedDataFromMongo(
  connectionString: string,
  databaseName?: string,
  orgId?: string,
): Promise<SyncedData | null> {
  const client = new MongoClient(connectionString.trim(), { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const dbName = databaseName?.trim() || resolveDatabaseName(connectionString);
    const db: Db = client.db(dbName);
    const doc = await db.collection(COLLECTION).findOne({ _id: docIdForOrg(orgId) });
    if (!doc) return null;
    const { updatedAt: _u, _id: _i, ...rest } = doc as Record<string, unknown>;
    return rest as SyncedData;
  } finally {
    await client.close().catch(() => undefined);
  }
}
