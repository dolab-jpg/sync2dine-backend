import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { invalidateKBCache } from './building-control-kb';

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

interface RegistryDoc {
  id: string;
  title: string;
  sourceUrl: string;
  versionDate: string;
  status: string;
  lastCheckedAt: string;
  lastModifiedHeader?: string;
  etag?: string;
}

function getRegistryPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return join(dir, 'data', 'building-control', 'registry.json');
}

function loadRegistry(): RegistryDoc[] {
  const path = getRegistryPath();
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveRegistry(docs: RegistryDoc[]): void {
  writeFileSync(getRegistryPath(), JSON.stringify(docs, null, 2), 'utf-8');
  invalidateKBCache();
}

export interface DocUpdateCheck {
  docId: string;
  title: string;
  sourceUrl: string;
  currentVersionDate: string;
  detectedChange: boolean;
  lastModified?: string;
  etag?: string;
  checkedAt: string;
  message: string;
}

async function checkDocSource(doc: RegistryDoc): Promise<DocUpdateCheck> {
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(doc.sourceUrl, { method: 'HEAD', redirect: 'follow' });
    const lastModified = res.headers.get('last-modified') ?? undefined;
    const etag = res.headers.get('etag') ?? undefined;

    const prevModified = doc.lastModifiedHeader;
    const prevEtag = doc.etag;
    const detectedChange = Boolean(
      (lastModified && prevModified && lastModified !== prevModified)
      || (etag && prevEtag && etag !== prevEtag)
    );

    return {
      docId: doc.id,
      title: doc.title,
      sourceUrl: doc.sourceUrl,
      currentVersionDate: doc.versionDate,
      detectedChange,
      lastModified,
      etag,
      checkedAt,
      message: detectedChange
        ? 'Source may have been updated — staff review required'
        : 'No change detected',
    };
  } catch (err) {
    return {
      docId: doc.id,
      title: doc.title,
      sourceUrl: doc.sourceUrl,
      currentVersionDate: doc.versionDate,
      detectedChange: false,
      checkedAt,
      message: `Check failed: ${String(err)}`,
    };
  }
}

export async function handleBuildingControlRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname === '/api/building-control/registry' && req.method === 'GET') {
    sendJson(res, 200, { documents: loadRegistry() });
    return true;
  }

  if (pathname === '/api/building-control/check-updates' && req.method === 'POST') {
    const docs = loadRegistry();
    const results: DocUpdateCheck[] = [];
    for (const doc of docs) {
      results.push(await checkDocSource(doc));
    }

    const updated = docs.map((doc) => {
      const check = results.find((r) => r.docId === doc.id);
      if (!check) return doc;
      const next = {
        ...doc,
        lastCheckedAt: check.checkedAt,
        lastModifiedHeader: check.lastModified ?? doc.lastModifiedHeader,
        etag: check.etag ?? doc.etag,
      };
      if (check.detectedChange && doc.status === 'current') {
        return { ...next, status: 'pending_review' };
      }
      return next;
    });

    saveRegistry(updated);
    sendJson(res, 200, { results, pendingCount: results.filter((r) => r.detectedChange).length });
    return true;
  }

  if (pathname === '/api/building-control/approve' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const docId = String(body.docId ?? '');
    const action = String(body.action ?? 'approve');
    const docs = loadRegistry();
    const idx = docs.findIndex((d) => d.id === docId);
    if (idx < 0) {
      sendJson(res, 404, { error: 'Document not found' });
      return true;
    }

    if (action === 'approve') {
      docs[idx] = {
        ...docs[idx],
        status: 'current',
        versionDate: String(body.versionDate ?? docs[idx].versionDate),
        lastCheckedAt: new Date().toISOString(),
      };
    } else if (action === 'reject') {
      docs[idx] = {
        ...docs[idx],
        status: 'current',
        lastCheckedAt: new Date().toISOString(),
      };
    }

    saveRegistry(docs);
    sendJson(res, 200, { success: true, document: docs[idx] });
    return true;
  }

  return false;
}
