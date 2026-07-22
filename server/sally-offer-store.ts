/**
 * Platform-wide Sally commercial offer — editable by platform_owner in UI.
 * Stored separately from per-tenant agent settings.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  SAAS_PRODUCT_IDS,
  SAAS_PRODUCTS,
  type SaasProductId,
  type SaasProductPrice,
  type SaasProductPrices,
  defaultSaasProductPrices,
} from './saas-products';
import {
  FARE_SCHEDULE_VERSION,
  SAAS_PACKAGE_IDS,
  SAAS_PACKAGES,
  type SaasPackageId,
  formatFareSummary,
} from './saas-packages';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const OFFER_FILE = join(DATA_DIR, 'sally-offer.json');

export type SallyOfferStored = {
  /** @deprecated Prefer products.phone_agent — kept for migration. */
  monthlyPriceGbp?: number;
  /** @deprecated Prefer per-product setup — kept for migration. */
  setupFeeGbp?: number;
  products?: Partial<Record<SaasProductId, Partial<SaasProductPrice>>>;
  /** ISO datetime when launch weekly offer ends. After this, use standard weekly. */
  offerEndsAt?: string;
  /** Patent / authority references for Sally. */
  patentRefs?: string;
  founderName?: string;
  authorityBlurb?: string;
  minimumTerm?: string;
  cancelPolicy?: string;
  demoPhone?: string;
  demoVideoUrl?: string;
  salesPdfUrl?: string;
  fareScheduleVersion?: string;
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

function coercePrice(partial: Partial<SaasProductPrice> | undefined, fallback: SaasProductPrice): SaasProductPrice {
  const monthly = Number(partial?.monthlyPriceGbp);
  const setup = Number(partial?.setupFeeGbp);
  const weekly = Number(partial?.weeklyPriceGbp);
  const standardWeekly = Number(partial?.standardWeeklyGbp);
  const annual = Number(partial?.annualPrepayGbp);
  return {
    monthlyPriceGbp: Number.isFinite(monthly) && monthly > 0 ? monthly : fallback.monthlyPriceGbp,
    setupFeeGbp: Number.isFinite(setup) && setup >= 0 ? setup : fallback.setupFeeGbp,
    weeklyPriceGbp: Number.isFinite(weekly) && weekly > 0 ? weekly : fallback.weeklyPriceGbp,
    standardWeeklyGbp:
      Number.isFinite(standardWeekly) && standardWeekly > 0 ? standardWeekly : fallback.standardWeeklyGbp,
    annualPrepayGbp: Number.isFinite(annual) && annual > 0 ? annual : fallback.annualPrepayGbp,
  };
}

/** Resolve per-SKU prices, migrating legacy top-level monthly/setup onto phone_agent. */
export function resolveStoredProductPrices(stored: SallyOfferStored): SaasProductPrices {
  const defaults = defaultSaasProductPrices();
  const legacyMonthly = Number(stored.monthlyPriceGbp);
  const legacySetup = Number(stored.setupFeeGbp);

  if (Number.isFinite(legacyMonthly) && legacyMonthly > 0) {
    defaults.phone_agent.monthlyPriceGbp = legacyMonthly;
  }
  if (Number.isFinite(legacySetup) && legacySetup >= 0) {
    defaults.phone_agent.setupFeeGbp = legacySetup;
  }

  const out = { ...defaults };
  for (const id of SAAS_PRODUCT_IDS) {
    out[id] = coercePrice(stored.products?.[id], defaults[id]);
  }
  return out;
}

/** Whether the launch (40% off) offer is still active. */
export function isLaunchOfferActive(stored?: SallyOfferStored): boolean {
  const s = stored ?? load();
  const ends = (s.offerEndsAt || '').trim();
  if (!ends) return true;
  const t = Date.parse(ends);
  if (!Number.isFinite(t)) return true;
  return Date.now() < t;
}

export function getPackagePriceSnapshot(packageId: SaasPackageId, stored?: SallyOfferStored) {
  const pkg = SAAS_PACKAGES[packageId];
  const launchActive = isLaunchOfferActive(stored);
  return {
    packageId,
    name: pkg.name,
    standardWeeklyGbp: pkg.standardWeeklyGbp,
    launchWeeklyGbp: pkg.launchWeeklyGbp,
    weeklyGbp: launchActive ? pkg.launchWeeklyGbp : pkg.standardWeeklyGbp,
    annualPrepayGbp: pkg.annualPrepayGbp,
    launchActive,
    offerEndsAt: (stored ?? load()).offerEndsAt || null,
    fareScheduleVersion: (stored ?? load()).fareScheduleVersion || FARE_SCHEDULE_VERSION,
    weeklyAiMinutes: pkg.weeklyAiMinutes,
    weeklyOutboundMinutes: pkg.weeklyOutboundMinutes,
    aiOverageGbpPerMinute: pkg.aiOverageGbpPerMinute,
    inboundOnly: pkg.inboundOnly,
    includesAtmosphere: pkg.includesAtmosphere,
    fareSummary: formatFareSummary(pkg),
  };
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
  if (patch.products !== undefined && patch.products && typeof patch.products === 'object') {
    const merged: Partial<Record<SaasProductId, Partial<SaasProductPrice>>> = {
      ...(prev.products || {}),
    };
    for (const id of SAAS_PRODUCT_IDS) {
      const incoming = patch.products[id];
      if (!incoming) continue;
      merged[id] = { ...(merged[id] || {}), ...incoming };
      const monthly = Number(incoming.monthlyPriceGbp);
      const setup = Number(incoming.setupFeeGbp);
      const weekly = Number(incoming.weeklyPriceGbp);
      if (Number.isFinite(monthly) && monthly > 0) merged[id]!.monthlyPriceGbp = monthly;
      if (Number.isFinite(setup) && setup >= 0) merged[id]!.setupFeeGbp = setup;
      if (Number.isFinite(weekly) && weekly > 0) merged[id]!.weeklyPriceGbp = weekly;
    }
    next.products = merged;
    if (merged.phone_agent?.monthlyPriceGbp != null) {
      next.monthlyPriceGbp = Number(merged.phone_agent.monthlyPriceGbp);
    }
    if (merged.phone_agent?.setupFeeGbp != null) {
      next.setupFeeGbp = Number(merged.phone_agent.setupFeeGbp);
    }
  }
  if (patch.offerEndsAt !== undefined) {
    next.offerEndsAt = String(patch.offerEndsAt || '').trim();
  }
  if (patch.patentRefs !== undefined) {
    next.patentRefs = String(patch.patentRefs || '').trim();
  }
  if (patch.founderName !== undefined) {
    next.founderName = String(patch.founderName || '').trim();
  }
  if (patch.authorityBlurb !== undefined) {
    next.authorityBlurb = String(patch.authorityBlurb || '').trim();
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
  if (patch.fareScheduleVersion !== undefined) {
    next.fareScheduleVersion = String(patch.fareScheduleVersion || '').trim() || FARE_SCHEDULE_VERSION;
  }

  next.updatedAt = new Date().toISOString();
  if (updatedBy) next.updatedBy = updatedBy;
  if (!next.fareScheduleVersion) next.fareScheduleVersion = FARE_SCHEDULE_VERSION;
  persist(next);
  return { ...next };
}

export function catalogDefaultsNote(): string {
  return SAAS_PACKAGE_IDS.map((id) => {
    const p = SAAS_PACKAGES[id];
    return `${p.name} £${p.launchWeeklyGbp}/wk launch · £${p.standardWeeklyGbp}/wk std`;
  }).join('; ');
}

export function allPackageSnapshots(stored?: SallyOfferStored) {
  return SAAS_PACKAGE_IDS.map((id) => getPackagePriceSnapshot(id, stored));
}
