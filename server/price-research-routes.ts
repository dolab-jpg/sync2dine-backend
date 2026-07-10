import type { IncomingMessage, ServerResponse } from 'http';

export interface PriceRange {
  task: string;
  low: number;
  typical: number;
  high: number;
  unit: string;
  sources: { title: string; url: string }[];
}

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

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

async function tavilySearch(query: string, apiKey: string): Promise<SearchHit[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 5,
      search_depth: 'basic',
    }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? 'Result',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

async function serperSearch(query: string, apiKey: string): Promise<SearchHit[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, gl: 'uk' }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (data.organic ?? []).slice(0, 5).map((r) => ({
    title: r.title ?? 'Result',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }));
}

function mockRange(task: string): PriceRange {
  // Deterministic-ish indicative range from task length, so mock output is stable.
  const base = 80 + (task.length % 12) * 25;
  return {
    task,
    low: base,
    typical: Math.round(base * 1.4),
    high: Math.round(base * 1.9),
    unit: 'job',
    sources: [],
  };
}

export async function handlePriceResearchRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname !== '/api/ai/price-research') return false;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  let body: {
    tasks?: string[];
    tradeName?: string;
    postcode?: string;
    region?: string;
    provider?: string;
    searchApiKey?: string;
    apiKey?: string;
  };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return true;
  }

  const tasks = (body.tasks ?? []).map((t) => String(t).trim()).filter(Boolean);
  if (tasks.length === 0) {
    sendJson(res, 400, { error: 'No tasks provided' });
    return true;
  }

  const region = body.region || 'UK';
  const location = body.postcode ? `${body.postcode} ${region}` : region;
  const provider = body.provider || 'openai_web';

  const { resolveOpenAIApiKey } = await import('./openai-connection');
  let openaiKey: string | undefined;
  try {
    openaiKey = resolveOpenAIApiKey(body.apiKey);
  } catch {
    openaiKey = undefined;
  }

  // No AI available -> deterministic mock ranges.
  if (!openaiKey) {
    sendJson(res, 200, {
      provider: 'mock',
      items: tasks.map(mockRange),
      note: 'Mock price research — set OPENAI_API_KEY and a search provider for live local pricing.',
    });
    return true;
  }

  // Gather web context via the configured search provider (best effort).
  let searchContext = '';
  const collectedSources: { title: string; url: string }[] = [];
  if (provider === 'tavily' || provider === 'serper') {
    const searchKey = body.searchApiKey || process.env.PRICE_RESEARCH_API_KEY || '';
    if (searchKey) {
      const hits: SearchHit[] = [];
      for (const task of tasks.slice(0, 8)) {
        const query = `${task} ${body.tradeName ?? ''} cost price ${location} 2026`.trim();
        try {
          const found = provider === 'tavily'
            ? await tavilySearch(query, searchKey)
            : await serperSearch(query, searchKey);
          for (const h of found.slice(0, 3)) {
            hits.push(h);
            if (h.url) collectedSources.push({ title: h.title, url: h.url });
          }
        } catch {
          // ignore individual search failures
        }
      }
      searchContext = hits
        .map((h) => `- ${h.title}: ${h.snippet} (${h.url})`)
        .join('\n')
        .slice(0, 6000);
    }
  }

  try {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: openaiKey });

    const systemPrompt = [
      `You are a UK construction & trades pricing researcher for region "${location}".`,
      `Estimate realistic CURRENT local market prices (in GBP) for each task.`,
      `Bias toward the HIGHER end of the typical local range (premium installer pricing), but stay realistic.`,
      searchContext
        ? `Use these recent web search snippets as evidence where relevant:\n${searchContext}`
        : `No live search results available; use your best UK market knowledge for 2026.`,
      `Return JSON: { "items": [ { "task": string, "low": number, "typical": number, "high": number, "unit": "job"|"day"|"sqm"|"item"|"hour", "sources": [ { "title": string, "url": string } ] } ] }.`,
      `low <= typical <= high. Numbers are GBP, no currency symbols. Include sources only if you have real URLs from the snippets.`,
    ].join('\n\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Trade: ${body.tradeName ?? 'general'}\nLocation: ${location}\nTasks:\n${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content ?? '{"items":[]}';
    const parsed = JSON.parse(content) as { items?: PriceRange[] };
    const items: PriceRange[] = (parsed.items ?? []).map((item, idx) => ({
      task: item.task ?? tasks[idx] ?? `Task ${idx + 1}`,
      low: Number(item.low) || 0,
      typical: Number(item.typical) || 0,
      high: Number(item.high) || 0,
      unit: item.unit ?? 'job',
      sources: Array.isArray(item.sources)
        ? item.sources.filter((s) => s && s.url).slice(0, 4)
        : collectedSources.slice(0, 3),
    }));

    sendJson(res, 200, { provider, items, sources: collectedSources });
    return true;
  } catch (err) {
    sendJson(res, 200, {
      provider: 'mock',
      items: tasks.map(mockRange),
      note: `Price research failed (${err instanceof Error ? err.message : 'error'}) — returning indicative ranges.`,
    });
    return true;
  }
}
