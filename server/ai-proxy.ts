import type { IncomingMessage, ServerResponse } from 'http';
import { OpenAIConnectionError } from './openai-connection';
import { resolveOrgIdForRequest, isAuthEnforced, requireAuth } from './auth';
import { QuotaExceededError } from './usage';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function sendOpenAIConnectionError(res: ServerResponse, err: unknown) {
  if (err instanceof QuotaExceededError) {
    sendJson(res, 429, { error: err.message, code: 'quota_exceeded' });
    return;
  }
  if (err instanceof OpenAIConnectionError) {
    sendJson(res, 503, { error: err.message, code: err.code });
    return;
  }
  sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
}

function attachOrgContext(req: IncomingMessage, body: Record<string, unknown>) {
  const orgId = resolveOrgIdForRequest(req, body as { orgId?: string });
  if (orgId) body.orgId = orgId;
  return orgId;
}

export async function handleAiRequest(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (pathname === '/api/ai/health') {
    const { handleOpenAIHealth } = await import('./openai-health');
    await handleOpenAIHealth(req, res);
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (isAuthEnforced() && !requireAuth(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  const orgId = attachOrgContext(req, body);
  const { resolveOpenAIApiKey } = await import('./openai-connection');
  const apiKey = resolveOpenAIApiKey(body.apiKey as string | undefined, orgId);

  if (pathname === '/api/ai/cyrus') {
    const { handleCyrusChat } = await import('./cyrus-handler');
    try {
      const result = await handleCyrusChat(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendOpenAIConnectionError(res, err);
    }
    return;
  }

  if (pathname === '/api/ai/project') {
    const { handleProjectAI } = await import('./project-ai-handler');
    try {
      const result = await handleProjectAI(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendOpenAIConnectionError(res, err);
    }
    return;
  }

  if (pathname === '/api/ai/orchestrate') {
    const { handleOrchestrator } = await import('./orchestrator-handler');
    try {
      const result = await handleOrchestrator(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendOpenAIConnectionError(res, err);
    }
    return;
  }

  if (pathname === '/api/ai/staff') {
    const { handleStaffAI } = await import('./staff-ai-handler');
    try {
      const result = await handleStaffAI(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendOpenAIConnectionError(res, err);
    }
    return;
  }

  if (pathname === '/api/ai/building-control') {
    const { handleBuildingControl } = await import('./building-control-handler');
    try {
      const result = await handleBuildingControl(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendOpenAIConnectionError(res, err);
    }
    return;
  }

  if (pathname === '/api/ai/planning') {
    const { handlePlanningAI } = await import('./planning-ai-handler');
    try {
      const result = await handlePlanningAI(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendOpenAIConnectionError(res, err);
    }
    return;
  }

  if (pathname === '/api/ai/summarize') {
    const { handleSummarizeChat } = await import('./summarize-handler');
    try {
      const result = await handleSummarizeChat(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendOpenAIConnectionError(res, err);
    }
    return;
  }

  if (pathname === '/api/ai/categorize-transaction') {
    const { handleCategorizeTransaction } = await import('./categorize-transaction-handler');
    try {
      const result = await handleCategorizeTransaction(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendOpenAIConnectionError(res, err);
    }
    return;
  }

  if (!apiKey) {
    if (pathname === '/api/ai/estimate') {
      sendJson(res, 200, {
        suggestions: { length: { value: 2.5, confidence: 0.5 }, width: { value: 2.0, confidence: 0.5 } },
        risks: ['Mock mode — set OPENAI_API_KEY in .env.local'],
        summary: 'Mock AI estimation. Configure API key for real vision analysis.',
      });
      return;
    }
    if (pathname === '/api/ai/receipt') {
      const { handleReceiptRequest } = await import('./receipt-handler');
      const result = await handleReceiptRequest(body);
      sendJson(res, 200, result);
      return;
    }
    if (pathname === '/api/ai/chat') {
      sendJson(res, 200, { content: 'TradePro AI mock mode. Set OPENAI_API_KEY in .env.local or Integrations Hub for real responses.' });
      return;
    }
    if (pathname === '/api/ai/cyrus') {
      const name = (body.customerContext as { customerName?: string })?.customerName ?? 'there';
      sendJson(res, 200, { content: `Hi ${name}! I'm Cyrus (mock mode). Configure OpenAI in Settings → Integrations for live responses.` });
      return;
    }
    sendJson(res, 503, { error: 'OpenAI API key not configured' });
    return;
  }

  try {
    const { createOpenAIClientForOrg } = await import('./openai-connection');
    const { meteredSpeechCreate } = await import('./metered-openai');
    const openai = await createOpenAIClientForOrg(orgId, pathname, body.apiKey as string | undefined);

    if (pathname === '/api/ai/chat') {
      const completion = await openai.chat.completions.create({
        model: (body.model as string) ?? 'gpt-4o-mini',
        messages: [
          { role: 'system', content: (body.systemPrompt as string) ?? 'You are a helpful construction assistant.' },
          ...(body.messages as Array<{ role: string; content: string }>),
        ],
      });
      sendJson(res, 200, { content: completion.choices[0]?.message?.content ?? '' });
      return;
    }

    if (pathname === '/api/ai/estimate') {
      const imageContent = (body.images as string[]).map((img: string) => ({
        type: 'image_url' as const,
        image_url: { url: img },
      }));
      const schemaHint = body.schema
        ? `\n\nReturn JSON matching this schema exactly:\n${JSON.stringify(body.schema)}`
        : '';
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: `${body.systemPrompt}${schemaHint}\n\nEach suggestion must have value, confidence (0-1), and optional reason.` },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Analyze these site photos for trade: ${body.tradeId}. Return JSON with suggestions, risks (array), and summary.` },
              ...imageContent,
            ],
          },
        ],
        response_format: { type: 'json_object' },
      });
      const content = completion.choices[0]?.message?.content ?? '{}';
      sendJson(res, 200, JSON.parse(content));
      return;
    }

    if (pathname === '/api/ai/receipt') {
      const { handleReceiptRequest } = await import('./receipt-handler');
      const result = await handleReceiptRequest(body);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/ai/transcribe') {
      sendJson(res, 501, { error: 'Use browser speech recognition or implement multipart upload' });
      return;
    }

    if (pathname === '/api/ai/tts') {
      const mp3 = await meteredSpeechCreate(openai, orgId, pathname, {
        model: 'tts-1',
        voice: (body.voice as 'fable') ?? 'fable',
        input: String(body.text ?? ''),
      });
      const buffer = Buffer.from(await mp3.arrayBuffer());
      res.statusCode = 200;
      res.setHeader('Content-Type', 'audio/mpeg');
      res.end(buffer);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendOpenAIConnectionError(res, err);
  }
}
