import type { IncomingMessage, ServerResponse } from 'http';
import {
  mapOpenAIError,
  probeOpenAIConnection,
  resolveOpenAIApiKey,
} from './openai-connection';

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

const MISSING_MESSAGE =
  'OpenAI not connected — add your API key in Settings → Integrations → OpenAI and Save.';

export async function handleOpenAIHealth(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let bodyApiKey: string | undefined;
  if (req.method === 'POST') {
    try {
      const raw = await readBody(req);
      if (raw.trim()) {
        const body = JSON.parse(raw) as { apiKey?: string };
        bodyApiKey = body.apiKey;
      }
    } catch {
      sendJson(res, 400, { connected: false, reason: 'missing', message: MISSING_MESSAGE });
      return;
    }
  }

  const apiKey = resolveOpenAIApiKey(bodyApiKey);
  if (!apiKey) {
    sendJson(res, 200, { connected: false, reason: 'missing', message: MISSING_MESSAGE });
    return;
  }

  try {
    await probeOpenAIConnection(apiKey);
    sendJson(res, 200, { connected: true });
  } catch (err) {
    const mapped = mapOpenAIError(err);
    sendJson(res, 200, {
      connected: false,
      reason: mapped.code,
      message: mapped.message,
    });
  }
}
