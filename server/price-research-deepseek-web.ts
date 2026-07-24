/**
 * Live web snippets for price research via DeepSeek Anthropic-compatible web_search.
 * Same Company AI Brain DeepSeek key — no third-party search API required.
 */

export interface DeepSeekWebHit {
  title: string;
  url: string;
  snippet: string;
}

const DEEPSEEK_ANTHROPIC_BASE = 'https://api.deepseek.com/anthropic';
const DEFAULT_MODEL = 'deepseek-v4-flash';

interface ApiContentBlock {
  type: string;
  text?: string;
  content?: Array<Record<string, unknown>>;
}

/**
 * One query ? title/url hits + model text answer used as snippet context.
 * Best-effort: returns [] on failure so pricing can fall back to LLM knowledge.
 */
export async function deepseekWebSearch(
  query: string,
  apiKey: string,
  options?: { model?: string; signal?: AbortSignal },
): Promise<DeepSeekWebHit[]> {
  const model = options?.model?.startsWith('deepseek')
    ? options.model
    : DEFAULT_MODEL;

  const res = await fetch(`${DEEPSEEK_ANTHROPIC_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: options?.signal,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            'Search current UK market prices and summarise concrete £ figures with source context.',
            `Query: ${query}`,
            'Reply in plain text with typical price ranges and cite URLs when known.',
          ].join('\n'),
        },
      ],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      tool_choice: { type: 'auto' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    console.warn(`[price-research] DeepSeek web_search failed (${res.status}): ${errText.slice(0, 300)}`);
    return [];
  }

  const data = (await res.json()) as { content?: ApiContentBlock[] };
  const blocks = Array.isArray(data.content) ? data.content : [];
  const hits: DeepSeekWebHit[] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item.type === 'web_search_result') {
          hits.push({
            title: String(item.title || 'Result'),
            url: String(item.url || ''),
            snippet: '',
          });
        }
      }
    } else if (block.type === 'text' && block.text?.trim()) {
      textParts.push(block.text.trim());
    }
  }

  const answer = textParts.join('\n\n').slice(0, 2500);
  if (hits.length === 0 && answer) {
    return [{ title: 'DeepSeek web summary', url: '', snippet: answer }];
  }
  if (answer && hits.length > 0) {
    hits[0] = { ...hits[0], snippet: answer };
  }
  return hits.slice(0, 5);
}
