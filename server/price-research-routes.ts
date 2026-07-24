import type { IncomingMessage, ServerResponse } from 'http';
import { deepseekWebSearch, type DeepSeekWebHit } from './price-research-deepseek-web';

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

/** Normalise legacy openai_web → llm_only; accept deepseek_web / tavily / serper. */
export function normalizePriceResearchProvider(raw?: string): string {
  const p = (raw || process.env.PRICE_RESEARCH_PROVIDER || 'llm_only').trim();
  if (p === 'openai_web') return 'llm_only';
  if (p === 'deepseek_web' || p === 'tavily' || p === 'serper' || p === 'llm_only') return p;
  return 'llm_only';
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

function hitsToContext(hits: SearchHit[]): string {
  return hits
    .map((h) => `- ${h.title}: ${h.snippet} (${h.url})`)
    .join('\n')
    .slice(0, 6000);
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
    deepseekApiKey?: string;
    brainProvider?: string;
    orgId?: string;
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
  const provider = normalizePriceResearchProvider(body.provider);

  const { resolveOrgIdForRequest } = await import('./auth');
  const { resolveOpenAIApiKeyAsync, mapOpenAIError, OpenAIConnectionError } = await import('./openai-connection');
  const {
    createLLMClientForOrg,
    defaultChatModelForProvider,
    resolveDeepSeekApiKeyAsync,
    resolveBrainProvider,
  } = await import('./llm-connection');
  const orgId = resolveOrgIdForRequest(req, body);

  let openaiKey: string | undefined;
  try {
    openaiKey = await resolveOpenAIApiKeyAsync(body.apiKey, orgId);
  } catch {
    openaiKey = undefined;
  }
  const deepseekKey = await resolveDeepSeekApiKeyAsync(body.deepseekApiKey, orgId);
  const brainProvider = resolveBrainProvider(body.brainProvider, orgId);

  // Company AI Brain: DeepSeek and/or OpenAI — no silent mock.
  if (!openaiKey && !deepseekKey) {
    sendJson(res, 503, {
      error: 'AI brain not connected — add a DeepSeek or OpenAI key in Settings → Integrations → Company AI Brain and Save.',
      code: 'missing',
      provider: 'none',
    });
    return true;
  }

  if (provider === 'deepseek_web' && !deepseekKey) {
    sendJson(res, 503, {
      error: 'DeepSeek live web requires a DeepSeek API key — add it in Settings → Integrations → Company AI Brain.',
      code: 'missing',
      provider: 'deepseek_web',
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
      searchContext = hitsToContext(hits);
    }
  } else if (provider === 'deepseek_web' && deepseekKey) {
    const hits: SearchHit[] = [];
    for (const task of tasks.slice(0, 8)) {
      const query = `${task} ${body.tradeName ?? ''} cost price ${location} 2026`.trim();
      try {
        const found: DeepSeekWebHit[] = await deepseekWebSearch(query, deepseekKey, {
          model: defaultChatModelForProvider('deepseek'),
        });
        for (const h of found.slice(0, 3)) {
          hits.push(h);
          if (h.url) collectedSources.push({ title: h.title, url: h.url });
        }
      } catch (err) {
        console.warn('[price-research] deepseek_web task failed:', err instanceof Error ? err.message : err);
      }
    }
    searchContext = hitsToContext(hits);
  }

  try {
    let preferredBrain =
      provider === 'deepseek_web'
        ? 'deepseek'
        : body.brainProvider || brainProvider;
    // Prefer whichever Company AI Brain key is available.
    if (preferredBrain === 'deepseek' && !deepseekKey && openaiKey) preferredBrain = 'openai';
    if (preferredBrain === 'openai' && !openaiKey && deepseekKey) preferredBrain = 'deepseek';

    const { client, provider: activeBrain } = await createLLMClientForOrg(orgId, pathname, {
      bodyOpenAIApiKey: body.apiKey,
      bodyDeepSeekApiKey: body.deepseekApiKey,
      provider: preferredBrain,
    });
    const model = defaultChatModelForProvider(activeBrain, 'gpt-4o-mini');

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

    const completion = await client.chat.completions.create({
      model,
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

    const responseProvider =
      provider === 'llm_only'
        ? (activeBrain === 'deepseek' ? 'deepseek' : 'openai')
        : provider;

    sendJson(res, 200, { provider: responseProvider, items, sources: collectedSources });
    return true;
  } catch (err) {
    if (err instanceof OpenAIConnectionError) {
      sendJson(res, 503, { error: err.message, code: err.code });
      return true;
    }
    const mapped = mapOpenAIError(err);
    sendJson(res, 503, { error: mapped.message, code: mapped.code });
    return true;
  }
}
