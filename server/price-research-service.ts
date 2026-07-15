import type { PriceRange } from './price-research-routes';
import { OpenAIConnectionError } from './openai-connection';

export async function researchTaskPrices(tasks: string[], options?: {
  tradeName?: string;
  postcode?: string;
  region?: string;
  orgId?: string | null;
}): Promise<{ provider: string; items: PriceRange[] }> {
  const region = options?.region || 'UK';
  const location = options?.postcode ? `${options.postcode} ${region}` : region;

  const { createLLMClientForOrg, defaultChatModelForProvider } = await import('./llm-connection');
  const { client, provider } = await createLLMClientForOrg(options?.orgId ?? null, '/api/ai/price-research');
  const model = defaultChatModelForProvider(provider, 'gpt-4o-mini');

  const systemPrompt = [
    `You are a UK construction pricing researcher for region "${location}".`,
    `Estimate realistic CURRENT local market prices (in GBP) for each task.`,
    `Bias toward the HIGHER end of the typical local range, but stay realistic.`,
    `Return JSON: { "items": [ { "task": string, "low": number, "typical": number, "high": number, "unit": "job"|"day"|"sqm"|"item"|"hour", "sources": [] } ] }.`,
  ].join('\n');

  try {
    const completion = await client.chat.completions.create({
      model,
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
    return { provider: provider === 'deepseek' ? 'deepseek' : 'openai', items };
  } catch (err) {
    if (err instanceof OpenAIConnectionError) throw err;
    throw new OpenAIConnectionError(
      err instanceof Error ? err.message : 'Price research failed',
      'rejected',
    );
  }
}

export function pickHigherEnd(line: { low: number; typical: number; high: number }): number {
  const buffer = 1.12;
  const candidate = Math.max(line.high || 0, (line.typical || 0) * buffer, line.low || 0);
  return Math.ceil(candidate / 250) * 250;
}
