/**
 * Local smoke: price-research provider normalize + deepseek_web gate.
 * Run: npx tsx scripts/smoke-price-research-gate.ts
 */
import { createServer } from 'http';
import { handlePriceResearchRoutes, normalizePriceResearchProvider } from '../server/price-research-routes';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(normalizePriceResearchProvider('openai_web') === 'llm_only', 'openai_web alias');
assert(normalizePriceResearchProvider('deepseek_web') === 'deepseek_web', 'deepseek_web');
assert(normalizePriceResearchProvider('tavily') === 'tavily', 'tavily');
assert(normalizePriceResearchProvider('llm_only') === 'llm_only', 'llm_only');
assert(normalizePriceResearchProvider('serper') === 'serper', 'serper');

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const handled = await handlePriceResearchRoutes(req, res, url.pathname);
  if (!handled) {
    res.statusCode = 404;
    res.end('not found');
  }
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('no port');
const port = addr.port;

// deepseek_web without a DeepSeek key must 503 (OpenAI alone is not enough for live web).
process.env.DEEPSEEK_API_KEY = '';
const res = await fetch(`http://127.0.0.1:${port}/api/ai/price-research`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tasks: ['tap replace'],
    provider: 'deepseek_web',
    apiKey: process.env.OPENAI_API_KEY || 'sk-test-placeholder-for-gate',
    brainProvider: 'openai',
  }),
});
const json = (await res.json()) as { error?: string; code?: string; provider?: string };
console.log('deepseek_web gate', res.status, json);
assert(res.status === 503, 'deepseek_web requires DeepSeek key');
assert(json.code === 'missing' || String(json.error || '').toLowerCase().includes('deepseek'), 'DeepSeek missing');
assert(String(json.error || '').toLowerCase().includes('deepseek'), 'message mentions DeepSeek');

server.close();
console.log('smoke-price-research-gate: OK');
