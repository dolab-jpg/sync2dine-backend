/**
 * Local JSON store for Sales Brain (fast path). Supabase tables are the long-term sink;
 * this keeps learning offline-capable on the VPS.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type { ObjectionCode, SalesOutcome } from './taxonomy';
import { dualWriteSalesBrainStore, hydrateSalesBrainFromSupabase } from './supabase-sync';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'sales-brain.json');

export type SalesBrainJob = {
  id: string;
  callId: string;
  orgId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  error?: string;
  agentPersona?: string;
  aim?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SalesCallInsight = {
  id: string;
  orgId: string;
  callId: string;
  agentPersona?: string;
  aim?: string | null;
  durationSec?: number;
  reachedDm?: string;
  rapportScore?: number;
  discoveryScore?: number;
  valueScore?: number;
  closeScore?: number;
  outcome?: SalesOutcome | string;
  objections: ObjectionCode[];
  competitors: string[];
  whatWorked?: string;
  whatFailed?: string;
  nextStep?: string;
  upsellPotential?: string;
  crossSellPotential?: string;
  createdAt: string;
};

export type SalesBrainRecommendation = {
  id: string;
  orgId: string;
  type: string;
  proposedText: string;
  evidenceSummary?: string;
  sampleSize: number;
  status: 'pending' | 'approved' | 'rejected' | 'rolled_back';
  createdAt: string;
  updatedAt: string;
};

export type SalesPlaybookSnippet = {
  id: string;
  orgId: string;
  slot: string;
  body: string;
  active: boolean;
  variantId?: string;
  createdAt: string;
  updatedAt: string;
};

type StoreShape = {
  jobs: SalesBrainJob[];
  insights: SalesCallInsight[];
  recommendations: SalesBrainRecommendation[];
  snippets: SalesPlaybookSnippet[];
};

let mem: StoreShape | null = null;
let memMtime = 0;

function empty(): StoreShape {
  return { jobs: [], insights: [], recommendations: [], snippets: [] };
}

function load(): StoreShape {
  try {
    if (existsSync(FILE)) {
      const mtime = statSync(FILE).mtimeMs;
      if (mem && mtime === memMtime) return mem;
      mem = JSON.parse(readFileSync(FILE, 'utf-8')) as StoreShape;
      mem.jobs ||= [];
      mem.insights ||= [];
      mem.recommendations ||= [];
      mem.snippets ||= [];
      memMtime = mtime;
      return mem;
    }
  } catch {
    /* ignore */
  }
  if (mem) return mem;
  mem = empty();
  return mem;
}

function save(s: StoreShape): void {
  mem = s;
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(s, null, 2), 'utf-8');
    memMtime = existsSync(FILE) ? statSync(FILE).mtimeMs : Date.now();
  } catch (err) {
    console.warn('[sales-brain] persist failed:', err instanceof Error ? err.message : err);
  }
  dualWriteSalesBrainStore(s);
}

let hydrateStarted = false;

export function getSalesBrainStore(): StoreShape {
  const s = load();
  if (!hydrateStarted) {
    hydrateStarted = true;
    void hydrateSalesBrainFromSupabase(s).then((merged) => {
      mem = merged;
      try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(FILE, JSON.stringify(merged, null, 2), 'utf-8');
        memMtime = existsSync(FILE) ? statSync(FILE).mtimeMs : Date.now();
      } catch {
        /* ignore */
      }
    });
  }
  return s;
}

export function syncSalesBrainStore(s: StoreShape): void {
  save(s);
}

export function newSalesBrainId(): string {
  return randomUUID();
}

export function listActiveSnippets(orgId: string, maxChars = 800): string {
  const s = load();
  const bodies = s.snippets
    .filter((x) => x.orgId === orgId && x.active)
    .map((x) => x.body.trim())
    .filter(Boolean);
  let out = '';
  for (const b of bodies) {
    const next = out ? `${out}\n${b}` : b;
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
}
