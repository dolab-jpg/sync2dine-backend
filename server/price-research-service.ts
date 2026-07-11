import type { PriceRange } from './price-research-routes';

function mockRange(task: string): PriceRange {
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

export async function researchTaskPrices(tasks: string[], options?: {
  tradeName?: string;
  postcode?: string;
  region?: string;
}): Promise<{ provider: string; items: PriceRange[] }> {
  const region = options?.region || 'UK';
  const location = options?.postcode ? `${options.postcode} ${region}` : region;

  try {
    const { resolveOpenAIApiKey } = await import('./openai-connection');
    const openaiKey = resolveOpenAIApiKey();
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: openaiKey });

    const systemPrompt = [
      `You are a UK construction pricing researcher for region "${location}".`,
      `Estimate realistic CURRENT local market prices (in GBP) for each task.`,
      `Bias toward the HIGHER end of the typical local range, but stay realistic.`,
      `Return JSON: { "items": [ { "task": string, "low": number, "typical": number, "high": number, "unit": "job"|"day"|"sqm"|"item"|"hour", "sources": [] } ] }.`,
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Trade: ${options?.tradeName ?? 'general'}\nTasks:\n${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content ?? '{"items":[]}';
    const parsed = JSON.parse(content) as { items?: PriceRange[] };
    const items = (parsed.items ?? []).map((item, idx) => ({
      task: item.task ?? tasks[idx] ?? `Task ${idx + 1}`,
      low: Number(item.low) || 0,
      typical: Number(item.typical) || 0,
      high: Number(item.high) || 0,
      unit: item.unit ?? 'job',
      sources: Array.isArray(item.sources) ? item.sources : [],
    }));
    return { provider: 'openai', items };
  } catch {
    return { provider: 'mock', items: tasks.map(mockRange) };
  }
}

export function pickHigherEnd(line: { low: number; typical: number; high: number }): number {
  const buffer = 1.12;
  const candidate = Math.max(line.high || 0, (line.typical || 0) * buffer, line.low || 0);
  return Math.ceil(candidate / 250) * 250;
}
