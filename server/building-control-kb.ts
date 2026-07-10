import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface KBChunk {
  id: string;
  docId: string;
  docTitle: string;
  shortTitle: string;
  section: string;
  text: string;
  versionDate: string;
  sourceUrl: string;
  trades: string[];
  status: string;
}

interface RegistryDoc {
  id: string;
  title: string;
  shortTitle: string;
  trades: string[];
  sourceUrl: string;
  versionDate: string;
  status: string;
  chunks: Array<{ id: string; section: string; text: string }>;
}

let cachedChunks: KBChunk[] | null = null;

function getRegistryPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return join(dir, 'data', 'building-control', 'registry.json');
}

function loadRegistry(): RegistryDoc[] {
  const path = getRegistryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.documents ?? [];
  } catch {
    return [];
  }
}

export function flattenChunks(docs: RegistryDoc[]): KBChunk[] {
  const chunks: KBChunk[] = [];
  for (const doc of docs) {
    if (doc.status !== 'current') continue;
    for (const chunk of doc.chunks ?? []) {
      chunks.push({
        id: chunk.id,
        docId: doc.id,
        docTitle: doc.title,
        shortTitle: doc.shortTitle,
        section: chunk.section,
        text: chunk.text,
        versionDate: doc.versionDate,
        sourceUrl: doc.sourceUrl,
        trades: doc.trades,
        status: doc.status,
      });
    }
  }
  return chunks;
}

export function getKnowledgeChunks(): KBChunk[] {
  if (cachedChunks) return cachedChunks;
  cachedChunks = flattenChunks(loadRegistry());
  return cachedChunks;
}

export function invalidateKBCache(): void {
  cachedChunks = null;
}

function scoreChunk(chunk: KBChunk, query: string, tradeId?: string): number {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length > 2);
  let score = 0;

  if (tradeId && chunk.trades.includes(tradeId)) score += 3;

  const haystack = `${chunk.docTitle} ${chunk.section} ${chunk.text} ${chunk.shortTitle}`.toLowerCase();
  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
  }

  const topicBoosts: Record<string, string[]> = {
    ventilation: ['part-f', 'extract', 'fan', 'ventilation'],
    electrical: ['part-p', 'bs7671', 'electrical', 'notifiable', 'zone'],
    drainage: ['part-h', 'drain', 'waste', 'trap'],
    waterproof: ['wet', 'tank', 'waterproof', 'shower'],
    fire: ['part-b', 'fire', 'escape'],
    structure: ['part-a', 'structural', 'load'],
    window: ['part-q', 'part-l', 'window', 'glazing'],
  };

  for (const [topic, keywords] of Object.entries(topicBoosts)) {
    if (q.includes(topic) || keywords.some((k) => q.includes(k))) {
      if (keywords.some((k) => haystack.includes(k))) score += 2;
    }
  }

  return score;
}

export function searchBuildingRegs(
  query: string,
  options?: { tradeId?: string; limit?: number }
): KBChunk[] {
  const limit = options?.limit ?? 6;
  const chunks = getKnowledgeChunks();

  return chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, query, options?.tradeId) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.chunk);
}
