/**
 * Platform-wide Sally commercial offer — editable by platform_owner in UI.
 * Stored separately from per-tenant agent settings.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const OFFER_FILE = join(DATA_DIR, 'sally-offer.json');

export type SallyOfferStored = {
  monthlyPriceGbp?: number;
  setupFeeGbp?: number;
  minimumTerm?: string;
  cancelPolicy?: string;
  demoPhone?: string;
  demoVideoUrl?: string;
  salesPdfUrl?: string;
  updatedAt?: string;
  updatedBy?: string;
};

let memory: SallyOfferStored | null = null;

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load(): SallyOfferStored {
  if (memory) return memory;
  try {
    if (existsSync(OFFER_FILE)) {
      const parsed = JSON.parse(readFileSync(OFFER_FILE, 'utf-8')) as SallyOfferStored;
      memory = parsed && typeof parsed === 'object' ? parsed : {};
      return memory;
    }
  } catch {
    /* ignore */
  }
  memory = {};
  return memory;
}

function persist(next: SallyOfferStored) {
  ensureDir();
  memory = next;
  try {
    writeFileSync(OFFER_FILE, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn('[sally-offer] persist failed:', err instanceof Error ? err.message : err);
  }
}

export function getSallyOfferStored(): SallyOfferStored {
  return { ...load() };
}

export function updateSallyOfferStored(
  patch: Partial<SallyOfferStored>,
  updatedBy?: string,
): SallyOfferStored {
  const prev = load();
  const next: SallyOfferStored = { ...prev };

  if (patch.monthlyPriceGbp !== undefined) {
    const n = Number(patch.monthlyPriceGbp);
    if (Number.isFinite(n) && n > 0) next.monthlyPriceGbp = n;
  }
  if (patch.setupFeeGbp !== undefined) {
    const n = Number(patch.setupFeeGbp);
    if (Number.isFinite(n) && n >= 0) next.setupFeeGbp = n;
  }
  if (patch.minimumTerm !== undefined) {
    next.minimumTerm = String(patch.minimumTerm || '').trim();
  }
  if (patch.cancelPolicy !== undefined) {
    next.cancelPolicy = String(patch.cancelPolicy || '').trim();
  }
  if (patch.demoPhone !== undefined) {
    next.demoPhone = String(patch.demoPhone || '').trim();
  }
  if (patch.demoVideoUrl !== undefined) {
    next.demoVideoUrl = String(patch.demoVideoUrl || '').trim();
  }
  if (patch.salesPdfUrl !== undefined) {
    next.salesPdfUrl = String(patch.salesPdfUrl || '').trim();
  }

  next.updatedAt = new Date().toISOString();
  if (updatedBy) next.updatedBy = updatedBy;
  persist(next);
  return { ...next };
}
