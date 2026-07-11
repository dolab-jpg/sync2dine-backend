import { getDataStore } from './data-store';

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function summarizeQuoteRecord(quote: Record<string, unknown>) {
  return {
    quoteId: String(quote.id ?? ''),
    customerId: String(quote.customerId ?? ''),
    customerName: String(quote.customerName ?? ''),
    tradeName: String(quote.tradeName ?? quote.tradeId ?? ''),
    status: String(quote.status ?? 'draft'),
    total: Number(quote.total ?? 0),
    expiresAt: String(quote.expiresAt ?? ''),
    items: Array.isArray(quote.items) ? quote.items : [],
    labour: Array.isArray(quote.labour) ? quote.labour : [],
    extras: Array.isArray(quote.extras) ? quote.extras : [],
    pricingResearch: quote.pricingResearch ?? null,
  };
}

export function lookupQuotesFromStore(options: {
  quoteId?: string | null;
  customerId?: string | null;
}): Record<string, unknown> {
  const store = getDataStore();
  const quotes = store.quotes ?? [];
  const { quoteId, customerId } = options;

  let matches = quotes.filter((q) => {
    const id = String(q.id ?? '');
    const cid = String(q.customerId ?? '');
    if (quoteId && id === quoteId) return true;
    if (customerId && cid === customerId) return true;
    return false;
  });

  if (matches.length === 0 && (quoteId || customerId)) {
    const projects = store.projects.filter((p) => {
      if (quoteId && String(p.quoteId ?? '') === quoteId) return true;
      if (customerId && String(p.customerId ?? '') === customerId) return true;
      return false;
    });
    matches = projects.map((p) => ({
      id: firstString(p.quoteId, quoteId),
      customerId: p.customerId,
      customerName: p.customerName,
      tradeName: p.tradeName ?? p.tradeId,
      status: p.status ?? 'active',
      total: p.totalCustomerCost ?? 0,
      expiresAt: '',
      items: [],
      labour: [],
      extras: [],
    }));
  }

  return {
    count: matches.length,
    query: { quoteId: quoteId ?? null, customerId: customerId ?? null },
    quotes: matches.map((q) => summarizeQuoteRecord(q as Record<string, unknown>)),
  };
}

export function getActiveQuotesForCustomer(customerId: string | null): Array<{
  id: string;
  tradeName?: string;
  total: number;
  status: string;
  expiresAt: string;
}> {
  if (!customerId) return [];
  const store = getDataStore();
  return (store.quotes ?? [])
    .filter((q) => String(q.customerId ?? '') === customerId)
    .filter((q) => !['rejected', 'expired'].includes(String(q.status ?? '')))
    .map((q) => ({
      id: String(q.id ?? ''),
      tradeName: String(q.tradeName ?? q.tradeId ?? ''),
      total: Number(q.total ?? 0),
      status: String(q.status ?? 'draft'),
      expiresAt: String(q.expiresAt ?? ''),
    }));
}

export function formatQuoteBreakdownText(quotes: Array<Record<string, unknown>>): string {
  if (!quotes.length) return 'No quotes found.';
  return quotes.map((q) => {
    const lines: string[] = [
      `${q.tradeName ?? 'Quote'} — £${Number(q.total ?? 0).toLocaleString('en-GB')} (${q.status})`,
    ];
    const items = q.items as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(items) && items.length) {
      for (const it of items) {
        lines.push(`  • ${String(it.name ?? it.description ?? 'Item')}: £${Number(it.price ?? it.total ?? 0).toLocaleString('en-GB')}`);
      }
    }
    const research = q.pricingResearch as { lines?: Array<Record<string, unknown>> } | null;
    if (research?.lines?.length) {
      lines.push('  Price research:');
      for (const l of research.lines) {
        lines.push(`    ${l.task}: low £${l.low} / typical £${l.typical} / high £${l.high}`);
      }
    }
    return lines.join('\n');
  }).join('\n\n');
}
