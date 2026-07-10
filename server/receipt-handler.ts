export interface ReceiptLineItem {
  description: string;
  qty: number;
  unitPrice: number;
  total: number;
  category: string;
}

export interface ReceiptParseResult {
  supplier: string;
  date: string;
  items: ReceiptLineItem[];
  subtotal: number;
  vat: number;
  total: number;
  confidence: number;
  aiSummary: string;
  flagged: boolean;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function readNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildMockReceipt(): ReceiptParseResult {
  return {
    supplier: 'Topps Tiles',
    date: new Date().toISOString().split('T')[0],
    items: [
      { description: 'Metro white tiles 600x300', qty: 12, unitPrice: 18.5, total: 222, category: 'tiles' },
      { description: 'Tile adhesive 20kg', qty: 2, unitPrice: 14.99, total: 29.98, category: 'fixings' },
      { description: 'Grout grey 5kg', qty: 1, unitPrice: 8.5, total: 8.5, category: 'fixings' },
    ],
    subtotal: 260.48,
    vat: 52.1,
    total: 312.58,
    confidence: 0.72,
    aiSummary: 'Tiles and fixing materials from Topps Tiles — mock mode (set OPENAI_API_KEY for live OCR).',
    flagged: false,
  };
}

function normaliseItems(raw: unknown): ReceiptLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const qty = readNumber(row.qty ?? row.quantity, 1);
      const unitPrice = readNumber(row.unitPrice ?? row.price, 0);
      const total = readNumber(row.total, qty * unitPrice);
      const description = readString(row.description ?? row.name, 'Item');
      const category = readString(row.category, 'materials').toLowerCase();
      return { description, qty, unitPrice, total, category };
    })
    .filter((item): item is ReceiptLineItem => Boolean(item));
}

function parseReceiptResponse(parsed: Record<string, unknown>): ReceiptParseResult {
  const items = normaliseItems(parsed.items);
  const subtotal = readNumber(parsed.subtotal, items.reduce((s, i) => s + i.total, 0));
  const vat = readNumber(parsed.vat ?? parsed.VAT, 0);
  const total = readNumber(parsed.total, subtotal + vat);
  const confidence = Math.max(0, Math.min(1, readNumber(parsed.confidence, 0.7)));
  const flagged = confidence < 0.5 || items.length === 0 || total <= 0;

  return {
    supplier: readString(parsed.supplier, 'Unknown supplier'),
    date: readString(parsed.date, new Date().toISOString().split('T')[0]),
    items,
    subtotal,
    vat,
    total,
    confidence,
    aiSummary: readString(parsed.aiSummary, `Receipt from ${readString(parsed.supplier, 'supplier')} — £${total.toFixed(2)}`),
    flagged,
  };
}

export async function parseReceiptFromImage(options: {
  apiKey?: string;
  images: string[];
  projectName?: string;
}): Promise<ReceiptParseResult> {
  if (!options.apiKey || options.images.length === 0) {
    return buildMockReceipt();
  }

  try {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: options.apiKey });
    const imageContent = options.images.slice(0, 3).map((url) => ({
      type: 'image_url' as const,
      image_url: { url },
    }));

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You are a UK construction receipt OCR assistant.',
            'Extract supplier name, date (YYYY-MM-DD), line items with description, qty, unitPrice, total.',
            'Categorise each item: tiles, plumbing, electrical, fixings, timber, paint, tools, labour, other.',
            'Return strict JSON: supplier, date, items[], subtotal, vat, total, confidence (0-1), aiSummary (one line).',
            'Use GBP. If unreadable set confidence below 0.5.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Parse this receipt${options.projectName ? ` for project: ${options.projectName}` : ''}.` },
            ...imageContent,
          ],
        },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parseReceiptResponse(parsed);
  } catch {
    return buildMockReceipt();
  }
}

export async function handleReceiptRequest(body: Record<string, unknown>): Promise<ReceiptParseResult> {
  const apiKey = (body.apiKey as string) || process.env.OPENAI_API_KEY;
  const images = Array.isArray(body.images) ? (body.images as string[]) : [];
  const projectName = readString(body.projectName);
  return parseReceiptFromImage({ apiKey, images, projectName });
}
