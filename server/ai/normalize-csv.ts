/**
 * DeepSeek-assisted UK takeaway CSV column mapping + local E.164 conversion.
 * LLM maps headers from a small sample; every row (including phone) is applied locally.
 */
import {
  createLLMClientForOrg,
  OpenAIConnectionError,
} from './llm-connection';
import { isPlausibleUkE164, toUkE164 } from '../phone/vapi-client';

const SAMPLE_CAP = 8;

export type NormalizeCsvColumnMap = {
  restaurant: string;
  contact: string;
  phone: string;
  address: string;
};

export type NormalizedLeadRow = {
  restaurant: string;
  contact: string | null;
  phoneE164: string;
  address: string;
  website: string;
  hours: string;
  phoneNeedsResearch: boolean;
};

export type NormalizeCsvBody = {
  headers?: string[];
  sampleRows?: string[][];
  rows?: string[][];
};

export type NormalizeCsvResult = {
  rows: NormalizedLeadRow[];
  columnMap?: NormalizeCsvColumnMap;
  source: 'deepseek' | 'heuristic';
};

function headerKey(h: string): string {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function findHeader(headers: string[], keys: string[], { exclude }: { exclude?: string[] } = {}): string {
  const lowerKeys = keys.map((k) => k.toLowerCase());
  const excludeSet = new Set((exclude || []).map((e) => headerKey(e)));
  const indexed = headers.map((h, i) => ({ h, k: headerKey(h), i }));
  const exact = indexed.find((row) => lowerKeys.includes(row.k) && !excludeSet.has(row.k));
  if (exact) return exact.h;
  const fuzzy = indexed.find(
    (row) => !excludeSet.has(row.k) && lowerKeys.some((k) => row.k.includes(k) || k.includes(row.k)),
  );
  return fuzzy?.h || '';
}

export function heuristicColumnMap(headers: string[]): NormalizeCsvColumnMap {
  const restaurant = findHeader(headers, [
    'company_name', 'company', 'business_name', 'restaurant', 'venue', 'name',
  ], { exclude: ['contact_name', 'contact', 'person', 'manager', 'lead_id'] });
  const contact = findHeader(headers, ['contact_name', 'contact', 'manager', 'person', 'poc']);
  const phone = findHeader(headers, ['phone', 'telephone', 'tel', 'mobile', 'landline']);
  const address = findHeader(headers, ['address', 'street', 'town', 'postcode', 'area']);
  return { restaurant, contact, phone, address };
}

function cell(row: string[], headers: string[], headerName: string): string {
  if (!headerName) return '';
  const i = headers.findIndex(
    (h) => h === headerName || headerKey(h) === headerKey(headerName),
  );
  if (i < 0) return '';
  return String(row[i] ?? '').trim();
}

function resolveMappedHeader(headers: string[], value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value) && headers[value]) {
    return headers[value];
  }
  if (typeof value !== 'string') return '';
  const t = value.trim();
  if (!t) return '';
  const exact = headers.find((h) => h === t || headerKey(h) === headerKey(t));
  if (exact) return exact;
  const asNum = Number(t);
  if (Number.isInteger(asNum) && asNum >= 0 && headers[asNum]) return headers[asNum];
  return '';
}

export function applyColumnMapToRows(
  headers: string[],
  rows: string[][],
  map: NormalizeCsvColumnMap,
  opts?: { defaultContact?: string | null },
): NormalizedLeadRow[] {
  const websiteHeader = findHeader(headers, ['website', 'url', 'web', 'domain']);
  const hoursHeader = findHeader(headers, [
    'opening_hours', 'hours', 'trading_hours', 'openinghours',
  ]);
  const defaultContact = opts?.defaultContact;

  return rows.map((row) => {
    const restaurant = cell(row, headers, map.restaurant);
    const contactRaw = cell(row, headers, map.contact);
    const phoneRaw = cell(row, headers, map.phone);
    const address = cell(row, headers, map.address);
    const website = cell(row, headers, websiteHeader);
    const hours = cell(row, headers, hoursHeader);
    const phoneE164 = phoneRaw ? toUkE164(phoneRaw) : '';
    const phoneNeedsResearch = !phoneRaw || !isPlausibleUkE164(phoneE164);
    let contact: string | null;
    if (contactRaw) contact = contactRaw;
    else if (defaultContact !== undefined) contact = defaultContact;
    else contact = null;
    return {
      restaurant,
      contact,
      phoneE164: phoneNeedsResearch && !phoneRaw ? '' : phoneE164,
      address,
      website,
      hours,
      phoneNeedsResearch,
    };
  });
}

function parseColumnMap(raw: Record<string, unknown>, headers: string[]): NormalizeCsvColumnMap | null {
  const src = (raw.columnMap && typeof raw.columnMap === 'object'
    ? raw.columnMap
    : raw) as Record<string, unknown>;
  const restaurant = resolveMappedHeader(headers, src.restaurant ?? src.company ?? src.company_name);
  const phone = resolveMappedHeader(headers, src.phone ?? src.telephone);
  if (!restaurant && !phone) return null;
  return {
    restaurant,
    contact: resolveMappedHeader(headers, src.contact ?? src.contact_name),
    phone,
    address: resolveMappedHeader(headers, src.address),
  };
}

const SYSTEM_PROMPT = [
  'You map columns of a UK takeaway / restaurant lead spreadsheet.',
  'company_name (or similar) is the venue, not a person.',
  'Phone may omit the leading 0 or use +44 / 44. Example: 1296715055 in Winslow/MK18 is +441296715055.',
  'Never invent a random phone number. Do not emit row values — only columnMap using the exact header strings.',
  'Contact may be empty if there is no person column (the client fills Manager).',
  'Return ONLY JSON: { "columnMap": { "restaurant": "<header>", "contact": "<header or empty>", "phone": "<header>", "address": "<header or empty>" } }',
].join(' ');

async function mapColumnsWithDeepSeek(
  orgId: string,
  headers: string[],
  sampleRows: string[][],
): Promise<NormalizeCsvColumnMap | null> {
  const { client } = await createLLMClientForOrg(orgId, '/api/leads/normalize-csv', {
    provider: 'deepseek',
  });
  const completion = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({ headers, sampleRows: sampleRows.slice(0, SAMPLE_CAP) }),
      },
    ],
  });
  const content = completion.choices?.[0]?.message?.content || '';
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parseColumnMap(parsed, headers);
}

export async function normalizeLeadsCsv(
  body: NormalizeCsvBody,
  orgId: string,
): Promise<NormalizeCsvResult> {
  const headers = Array.isArray(body.headers)
    ? body.headers.map((h) => String(h ?? ''))
    : [];
  if (!headers.length) {
    throw new Error('headers is required');
  }
  const sampleRows = Array.isArray(body.sampleRows) ? body.sampleRows : [];
  const allRows = Array.isArray(body.rows) && body.rows.length
    ? body.rows
    : sampleRows;
  const samplesForLlm = (sampleRows.length ? sampleRows : allRows).slice(0, SAMPLE_CAP);

  let columnMap: NormalizeCsvColumnMap | null = null;
  let source: 'deepseek' | 'heuristic' = 'heuristic';
  try {
    columnMap = await mapColumnsWithDeepSeek(orgId, headers, samplesForLlm);
    if (columnMap) source = 'deepseek';
  } catch (err) {
    if (!(err instanceof OpenAIConnectionError)) {
      console.warn(
        '[normalize-csv] DeepSeek mapping failed, using heuristic:',
        err instanceof Error ? err.message : err,
      );
    }
    columnMap = null;
  }

  if (!columnMap) {
    columnMap = heuristicColumnMap(headers);
    source = 'heuristic';
  }

  const defaultContact = source === 'heuristic' ? 'Manager' : null;
  const rows = applyColumnMapToRows(headers, allRows, columnMap, { defaultContact });
  return { rows, columnMap, source };
}
