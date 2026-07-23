import type { IncomingMessage, ServerResponse } from 'http';
import { OpenAIConnectionError } from './openai-connection';
import { resolveOrgIdForRequest, isAuthEnforced, requireAuth } from '../auth';
import { getProfileByBearer } from '../account-auth';
import { QuotaExceededError } from '../usage';

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

type RequestAuth = { orgId: string | null; role: string };

async function authenticateRequest(req: IncomingMessage): Promise<RequestAuth | null> {
  const legacy = requireAuth(req);
  if (legacy) return { orgId: legacy.orgId, role: legacy.role };

  const profile = await getProfileByBearer(req);
  if (!profile) return null;
  return {
    orgId: typeof profile.org_id === 'string' ? profile.org_id : null,
    role: String(profile.role ?? ''),
  };
}

function attachOrgContext(req: IncomingMessage, body: Record<string, unknown>, auth: RequestAuth | null) {
  let orgId = auth?.orgId ?? null;
  if (!orgId && auth?.role === 'platform_owner') {
    const header = req.headers['x-org-id'];
    orgId = typeof header === 'string' && header.trim()
      ? header.trim()
      : typeof body.orgId === 'string' && body.orgId.trim()
        ? body.orgId.trim()
        : null;
  }
  if (!auth) orgId = resolveOrgIdForRequest(req, body as { orgId?: string });
  if (orgId) body.orgId = orgId;
  return orgId;
}

export async function handleAiRequest(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (pathname === '/api/ai/health') {
    const { handleOpenAIHealth } = await import('../openai-health');
    await handleOpenAIHealth(req, res);
    return;
  }

  if (pathname.startsWith('/api/ai/code-fix')) {
    const { handleCodeFixRoutes } = await import('../code-fix-handler');
    await handleCodeFixRoutes(req, res, pathname);
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let auth: RequestAuth | null = null;
  if (isAuthEnforced()) {
    auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
  }

  if (pathname === '/api/ai/transcribe') {
    const { handleTranscribeUpload } = await import('./orchestrate-stream');
    try {
      await handleTranscribeUpload(req, res);
    } catch (err) {
      sendOpenAIConnectionError(res, err);
    }
    return;
  }

  const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  const orgId = attachOrgContext(req, body, auth);
  const { resolveOpenAIApiKeyAsync } = await import('./openai-connection');
  const apiKey = await resolveOpenAIApiKeyAsync(body.apiKey as string | undefined, orgId);

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
    const { handleProjectAI } = await import('../project-ai-handler');
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

  if (pathname === '/api/ai/orchestrate/stream') {
    const { handleOrchestrateStream } = await import('./orchestrate-stream');
    try {
      await handleOrchestrateStream(req, res, body as Parameters<typeof handleOrchestrateStream>[2]);
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

  if (pathname === '/api/ai/compose-email') {
    const { handleComposeEmail } = await import('./compose-email-handler');
    try {
      const result = await handleComposeEmail(body);
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
    if (pathname === '/api/ai/receipt') {
      const { handleReceiptRequest } = await import('./receipt-handler');
      const result = await handleReceiptRequest(body);
      sendJson(res, 200, result);
      return;
    }
    // Never silently mock estimate/chat — require Company AI Brain / OpenAI.
    sendJson(res, 503, {
      error: 'OpenAI API key not configured — add your API key in Settings → Integrations → Company AI Brain and Save.',
      code: 'missing',
    });
    return;
  }

  try {
    const { createLLMClientForOrg, defaultChatModelForProvider } = await import('./llm-connection');
    const { meteredSpeechCreate } = await import('./metered-openai');
    const { client: openai, provider: brainProvider } = await createLLMClientForOrg(orgId, pathname, {
      bodyOpenAIApiKey: body.apiKey as string | undefined,
      bodyDeepSeekApiKey: body.deepseekApiKey as string | undefined,
      provider: body.provider as string | undefined,
    });

    if (pathname === '/api/ai/chat') {
      const completion = await openai.chat.completions.create({
        model: defaultChatModelForProvider(brainProvider, (body.model as string) ?? 'gpt-4o-mini'),
        messages: [
          { role: 'system', content: (body.systemPrompt as string) ?? 'You are a helpful construction assistant.' },
          ...(body.messages as Array<{ role: string; content: string }>),
        ],
      });
      sendJson(res, 200, { content: completion.choices[0]?.message?.content ?? '' });
      return;
    }

    if (pathname === '/api/ai/estimate') {
      // Vision always uses OpenAI specialist client
      const { createOpenAISpecialistClientForOrg } = await import('./llm-connection');
      const vision = await createOpenAISpecialistClientForOrg(orgId, pathname, body.apiKey as string | undefined);
      const imageContent = (body.images as string[]).map((img: string) => ({
        type: 'image_url' as const,
        image_url: { url: img },
      }));
      const docText = typeof body.documentText === 'string' && body.documentText.trim()
        ? `\n\nExtracted document text:\n${body.documentText.trim().slice(0, 12000)}`
        : '';
      const schemaHint = body.schema
        ? `\n\nReturn JSON matching this schema exactly:\n${JSON.stringify(body.schema)}`
        : '';
      const completion = await vision.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: `${body.systemPrompt}${schemaHint}\n\nEach suggestion must have value, confidence (0-1), and optional reason.` },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze these site photos${docText ? ' and documents' : ''} for trade: ${body.tradeId}. Return JSON with suggestions, risks (array), and summary.${docText}`,
              },
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

    if (pathname === '/api/ai/tts') {
      const { synthesizeSpeech } = await import('../tts');
      const tts = await synthesizeSpeech(String(body.text ?? ''), body.voice as string | undefined);
      res.statusCode = 200;
      res.setHeader('Content-Type', tts.contentType);
      res.end(tts.buffer);
      return;
    }

    if (pathname === '/api/ai/render') {
      const { handleAiRender } = await import('../render-handler');
      const result = await handleAiRender(body as { image?: string; prompt?: string; tradeId?: string }, openai);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendOpenAIConnectionError(res, err);
  }
}
