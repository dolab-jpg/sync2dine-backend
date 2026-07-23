/**
 * Sync2Dine SaaS sellable SKUs — bridges legacy product IDs to package catalog.
 * Prefer saas-packages.ts for new quote/checkout flows.
 */
import {
  ADDITIONAL_SITE_WEEKLY_GBP,
  FARE_SCHEDULE_VERSION,
  SAAS_PACKAGES,
  type SaasPackageId,
  formatFareSummary,
  getPackage,
  isSaasPackageId,
  legacyProductToPackage,
  monthlyEquivalentFromWeekly,
  priceForInterval,
  type BillingInterval,
} from '../saas-packages';

export {
  ADDITIONAL_SITE_WEEKLY_GBP,
  FARE_SCHEDULE_VERSION,
  SAAS_PACKAGES,
  formatFareSummary,
  getPackage,
  isSaasPackageId,
  legacyProductToPackage,
  monthlyEquivalentFromWeekly,
  priceForInterval,
};
export type { SaasPackageId, BillingInterval };

/** @deprecated Use SaasPackageId — kept for older quotes and Sally tool schemas. */
export const SAAS_PRODUCT_IDS = ['phone_agent', 'audio_management'] as const;
export type SaasProductId = (typeof SAAS_PRODUCT_IDS)[number];

export type SaasProductDef = {
  id: SaasProductId;
  name: string;
  description: string;
  /** Monthly equivalent of launch weekly (comparison only). */
  defaultMonthlyGbp: number;
  defaultSetupGbp: number;
  /** Canonical package this legacy SKU maps to. */
  packageId: SaasPackageId;
};

export const SAAS_PRODUCTS: Record<SaasProductId, SaasProductDef> = {
  phone_agent: {
    id: 'phone_agent',
    name: 'Judie',
    description: 'Judie AI receptionist for orders, bookings, and call handling',
    defaultMonthlyGbp: monthlyEquivalentFromWeekly(SAAS_PACKAGES.judie_starter.launchWeeklyGbp),
    defaultSetupGbp: 0,
    packageId: 'judie_starter',
  },
  audio_management: {
    id: 'audio_management',
    name: 'Atmosphere',
    description: 'Venue audio, promotional messaging, and staff training (Sync2Gear)',
    defaultMonthlyGbp: monthlyEquivalentFromWeekly(SAAS_PACKAGES.atmosphere.launchWeeklyGbp),
    defaultSetupGbp: 0,
    packageId: 'atmosphere',
  },
};

export type SaasProductPrice = {
  monthlyPriceGbp: number;
  setupFeeGbp: number;
  weeklyPriceGbp?: number;
  standardWeeklyGbp?: number;
  annualPrepayGbp?: number;
};

export type SaasProductPrices = Record<SaasProductId, SaasProductPrice>;

export type SaasQuoteLine = {
  id: string;
  productId: SaasProductId | SaasPackageId;
  description: string;
  quantity: number;
  unit: 'item' | 'fixed' | 'week' | 'year';
  rate: number;
  total: number;
  category: 'product' | 'extra' | 'site';
  packageId?: SaasPackageId;
  billingInterval?: BillingInterval;
};

export function isSaasProductId(value: unknown): value is SaasProductId {
  return typeof value === 'string' && (SAAS_PRODUCT_IDS as readonly string[]).includes(value);
}

export function normalizeSaasProductIds(raw: unknown): SaasProductId[] {
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const seen = new Set<SaasProductId>();
  for (const item of list) {
    if (isSaasProductId(item)) seen.add(item);
  }
  return SAAS_PRODUCT_IDS.filter((id) => seen.has(id));
}

export function normalizeSaasPackageIds(raw: unknown): SaasPackageId[] {
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const seen = new Set<SaasPackageId>();
  for (const item of list) {
    if (isSaasPackageId(item)) seen.add(item);
    else if (isSaasProductId(item)) seen.add(legacyProductToPackage(item));
  }
  return Array.from(seen);
}

export function defaultSaasProductPrices(): SaasProductPrices {
  const judie = SAAS_PACKAGES.judie_starter;
  const atmos = SAAS_PACKAGES.atmosphere;
  return {
    phone_agent: {
      monthlyPriceGbp: monthlyEquivalentFromWeekly(judie.launchWeeklyGbp),
      setupFeeGbp: 0,
      weeklyPriceGbp: judie.launchWeeklyGbp,
      standardWeeklyGbp: judie.standardWeeklyGbp,
      annualPrepayGbp: judie.annualPrepayGbp,
    },
    audio_management: {
      monthlyPriceGbp: monthlyEquivalentFromWeekly(atmos.launchWeeklyGbp),
      setupFeeGbp: 0,
      weeklyPriceGbp: atmos.launchWeeklyGbp,
      standardWeeklyGbp: atmos.standardWeeklyGbp,
      annualPrepayGbp: atmos.annualPrepayGbp,
    },
  };
}

export function resolveProductLines(
  selectedIds: SaasProductId[],
  prices: SaasProductPrices,
  quantities?: Partial<Record<SaasProductId, number>>,
  priceOverrides?: Partial<Record<SaasProductId, number>>,
): SaasQuoteLine[] {
  const lines: SaasQuoteLine[] = [];
  for (const id of selectedIds) {
    const def = SAAS_PRODUCTS[id];
    const qtyRaw = quantities?.[id];
    const quantity = Number.isFinite(Number(qtyRaw)) && Number(qtyRaw) > 0 ? Math.floor(Number(qtyRaw)) : 1;
    const override = priceOverrides?.[id];
    const rate =
      Number.isFinite(Number(override)) && Number(override) > 0
        ? Number(override)
        : prices[id]?.weeklyPriceGbp ??
          prices[id]?.monthlyPriceGbp ??
          def.defaultMonthlyGbp;
    const total = Math.round(quantity * rate * 100) / 100;
    const pkgId = def.packageId;
    lines.push({
      id: `saas-${id}`,
      productId: id,
      description: def.name,
      quantity,
      unit: 'week',
      rate,
      total,
      category: 'product',
      packageId: pkgId,
      billingInterval: 'weekly',
    });
  }

  let setupTotal = 0;
  for (const id of selectedIds) {
    const setup = prices[id]?.setupFeeGbp ?? SAAS_PRODUCTS[id].defaultSetupGbp;
    if (setup > 0) setupTotal += setup;
  }
  if (setupTotal > 0) {
    lines.push({
      id: 'saas-setup',
      productId: selectedIds[0]!,
      description: 'Setup fee',
      quantity: 1,
      unit: 'fixed',
      rate: setupTotal,
      total: setupTotal,
      category: 'extra',
    });
  }

  return lines;
}

/** Resolve quote lines from a canonical package (preferred path). */
export function resolvePackageLine(
  packageId: SaasPackageId,
  opts?: {
    interval?: BillingInterval;
    useLaunch?: boolean;
    additionalSites?: number;
    quantity?: number;
  },
): SaasQuoteLine[] {
  const pkg = getPackage(packageId);
  const interval = opts?.interval ?? 'weekly';
  const useLaunch = opts?.useLaunch !== false;
  const quantity = opts?.quantity && opts.quantity > 0 ? Math.floor(opts.quantity) : 1;
  const rate = priceForInterval(pkg, interval, useLaunch);
  const unit = interval === 'annual' ? 'year' : 'week';
  const lines: SaasQuoteLine[] = [
    {
      id: `pkg-${packageId}`,
      productId: packageId,
      description: `${pkg.name}${useLaunch && interval === 'weekly' ? ' (launch offer)' : ''}`,
      quantity,
      unit,
      rate,
      total: Math.round(quantity * rate * 100) / 100,
      category: 'product',
      packageId,
      billingInterval: interval,
    },
  ];

  const sites = Math.max(0, Math.floor(Number(opts?.additionalSites) || 0));
  if (sites > 0) {
    const siteRate =
      interval === 'annual' ? ADDITIONAL_SITE_WEEKLY_GBP * 52 * 0.5 : ADDITIONAL_SITE_WEEKLY_GBP;
    lines.push({
      id: 'pkg-additional-sites',
      productId: packageId,
      description: `Additional site${sites > 1 ? 's' : ''} (${sites})`,
      quantity: sites,
      unit,
      rate: siteRate,
      total: Math.round(sites * siteRate * 100) / 100,
      category: 'site',
      packageId,
      billingInterval: interval,
    });
  }

  return lines;
}

export function sumMonthly(lines: SaasQuoteLine[]): number {
  return lines
    .filter((l) => l.category === 'product')
    .reduce((sum, l) => {
      if (l.unit === 'week') return sum + monthlyEquivalentFromWeekly(l.total);
      if (l.unit === 'year') return sum + l.total / 12;
      return sum + l.total;
    }, 0);
}

export function sumQuoteTotal(lines: SaasQuoteLine[]): number {
  return Math.round(lines.reduce((sum, l) => sum + l.total, 0) * 100) / 100;
}

export function formatProductsSummary(lines: SaasQuoteLine[]): string {
  const products = lines.filter((l) => l.category === 'product' || l.category === 'site');
  if (!products.length) return 'No products';
  return products
    .map((l) => {
      const period = l.unit === 'year' ? 'yr' : l.unit === 'week' ? 'wk' : 'mo';
      return `${l.description} £${l.rate}/${period} × ${l.quantity}`;
    })
    .join('; ');
}
