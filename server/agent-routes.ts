import type { IncomingMessage, ServerResponse } from 'http';
import {
  deletePhoneLine,
  getAgentSettings,
  getAgentStatusSnapshot,
  getPhoneLineById,
  listPhoneLines,
  lookupContactByPhone,
  maskPhoneLine,
  savePhoneLine,
  updateAgentSettings,
} from './data-store';
import {
  getChatterboxConfig,
  resolveTtsTextFromCall,
  synthesizeSpeech,
} from './tts';
import {
  getSipBridgeUrl,
  registerAllEnabledLines,
  testLineConnection,
  unregisterLine,
} from './telephony/lineRegistry';

const OPENAI_TTS_VOICES = [
  { id: 'fable', name: 'Fable (OpenAI)', provider: 'openai' },
  { id: 'alloy', name: 'Alloy (OpenAI)', provider: 'openai' },
  { id: 'nova', name: 'Nova (OpenAI)', provider: 'openai' },
  { id: 'shimmer', name: 'Shimmer (OpenAI)', provider: 'openai' },
];

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

async function fetchChatterboxVoices(): Promise<Array<{ id: string; name: string; provider: string }>> {
  const config = getChatterboxConfig();
  if (!config) return [];

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetch(`${config.baseUrl}/voices`, { headers });
  if (!response.ok) {
    throw new Error(`Chatterbox API error (${response.status})`);
  }

  const data = await response.json() as unknown;
  if (Array.isArray(data)) {
    return data.map((v, i) => {
      const item = v as Record<string, unknown>;
      return {
        id: String(item.id ?? item.voice_id ?? `voice-${i}`),
        name: String(item.name ?? item.label ?? `Voice ${i + 1}`),
        provider: 'chatterbox',
      };
    });
  }
  if (data && typeof data === 'object' && Array.isArray((data as { voices?: unknown[] }).voices)) {
    return ((data as { voices: unknown[] }).voices).map((v, i) => {
      const item = v as Record<string, unknown>;
      return {
        id: String(item.id ?? item.voice_id ?? `voice-${i}`),
        name: String(item.name ?? item.label ?? `Voice ${i + 1}`),
        provider: 'chatterbox',
      };
    });
  }
  return [];
}

async function handleGetSettings(_req: IncomingMessage, res: ServerResponse) {
  sendJson(res, 200, getAgentSettings());
}

async function handlePatchSettings(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;
  if (typeof body.activeVoiceId === 'string') patch.activeVoiceId = body.activeVoiceId;
  const updated = updateAgentSettings(patch);
  sendJson(res, 200, updated);
}

async function handleGetStatus(_req: IncomingMessage, res: ServerResponse) {
  const snapshot = getAgentStatusSnapshot();
  sendJson(res, 200, {
    ...snapshot,
    isActive: getAgentSettings().isActive,
  });
}

async function handleGetVoices(_req: IncomingMessage, res: ServerResponse) {
  const settings = getAgentSettings();
  try {
    const chatterboxVoices = await fetchChatterboxVoices();
    if (chatterboxVoices.length > 0) {
      sendJson(res, 200, {
        provider: 'chatterbox',
        activeVoiceId: settings.activeVoiceId ?? null,
        voices: chatterboxVoices,
      });
      return;
    }
  } catch (err) {
    sendJson(res, 200, {
      provider: 'openai',
      activeVoiceId: settings.activeVoiceId ?? 'fable',
      voices: OPENAI_TTS_VOICES,
      fallback: true,
      message: err instanceof Error ? err.message : 'Chatterbox unavailable — using OpenAI TTS fallback',
    });
    return;
  }

  sendJson(res, 200, {
    provider: 'openai',
    activeVoiceId: settings.activeVoiceId ?? 'fable',
    voices: OPENAI_TTS_VOICES,
    fallback: true,
    message: 'Connect Chatterbox in Integrations for cloned voices.',
  });
}

async function handlePostVoice(req: IncomingMessage, res: ServerResponse) {
  const config = getChatterboxConfig();
  if (!config) {
    sendJson(res, 400, { error: 'Chatterbox not configured. Set CHATTERBOX_BASE_URL in environment.' });
    return;
  }

  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('multipart/form-data')) {
    sendJson(res, 400, { error: 'Expected multipart/form-data upload' });
    return;
  }

  const raw = await readBody(req);
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    sendJson(res, 400, { error: 'Missing multipart boundary' });
    return;
  }

  const boundary = boundaryMatch[1].trim();
  const parts = raw.split(`--${boundary}`);
  let name = '';
  let fileBuffer: Buffer | null = null;
  let filename = 'voice.wav';

  for (const part of parts) {
    if (!part.trim() || part.trim() === '--') continue;
    const [headerBlock, ...bodyParts] = part.split('\r\n\r\n');
    const body = bodyParts.join('\r\n\r\n').replace(/\r\n$/, '');
    const nameMatch = headerBlock.match(/name="([^"]+)"/);
    const filenameMatch = headerBlock.match(/filename="([^"]+)"/);
    const fieldName = nameMatch?.[1] ?? '';

    if (fieldName === 'name') {
      name = body.trim();
    } else if (filenameMatch || fieldName === 'file') {
      filename = filenameMatch?.[1] ?? 'voice.wav';
      fileBuffer = Buffer.from(body, 'binary');
    }
  }

  if (!name || !fileBuffer) {
    sendJson(res, 400, { error: 'name and file are required' });
    return;
  }

  const formData = new FormData();
  formData.append('name', name);
  formData.append('file', new Blob([fileBuffer]), filename);

  const headers: Record<string, string> = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetch(`${config.baseUrl}/voices`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    sendJson(res, response.status, { error: errText || 'Chatterbox upload failed' });
    return;
  }

  const result = await response.json().catch(() => ({}));
  sendJson(res, 200, { success: true, voice: result });
}

async function handleContactLookup(_req: IncomingMessage, res: ServerResponse, url: URL) {
  const phone = url.searchParams.get('phone')?.trim();
  if (!phone) {
    sendJson(res, 400, { error: 'phone query parameter is required' });
    return;
  }
  sendJson(res, 200, lookupContactByPhone(phone));
}

async function resolveTtsRequestInput(
  req: IncomingMessage,
  url: URL,
): Promise<{ text: string; voiceId?: string | null }> {
  if (req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const voiceId = typeof body.voiceId === 'string' ? body.voiceId : undefined;
    if (!text) throw new Error('text is required');
    return { text, voiceId };
  }

  const callId = url.searchParams.get('callId')?.trim();
  const textParam = url.searchParams.get('text')?.trim();
  const voiceId = url.searchParams.get('voiceId') ?? undefined;
  const text = textParam || (callId ? resolveTtsTextFromCall(callId) : null);
  if (!text) throw new Error('text or callId query parameter is required');
  return { text, voiceId };
}

async function handleAgentTts(req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const { text, voiceId } = await resolveTtsRequestInput(req, url);
    const result = await synthesizeSpeech(text, voiceId);
    res.statusCode = 200;
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TTS-Provider', result.provider);
    res.end(result.buffer);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'TTS failed' });
  }
}

async function handleGetLines(_req: IncomingMessage, res: ServerResponse) {
  sendJson(res, 200, {
    bridgeUrl: getSipBridgeUrl(),
    lines: listPhoneLines().map(maskPhoneLine),
  });
}

async function handlePostLine(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  const label = String(body.label ?? '').trim();
  const sipUsername = String(body.sipUsername ?? '').trim();
  const sipPassword = String(body.sipPassword ?? '').trim();
  const did = String(body.did ?? '').trim();
  if (!label || !sipUsername || !sipPassword || !did) {
    sendJson(res, 400, { error: 'label, sipUsername, sipPassword, and did are required' });
    return;
  }
  const line = savePhoneLine({
    label,
    sipUsername,
    sipPassword,
    did,
    sipDomain: typeof body.sipDomain === 'string' ? body.sipDomain : undefined,
    enabled: body.enabled !== false,
  });
  sendJson(res, 200, { line: maskPhoneLine(line) });
}

async function handlePatchLine(req: IncomingMessage, res: ServerResponse, lineId: string) {
  const existing = getPhoneLineById(lineId);
  if (!existing) {
    sendJson(res, 404, { error: 'Line not found' });
    return;
  }
  const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  const sipPassword = typeof body.sipPassword === 'string' && body.sipPassword && body.sipPassword !== '••••••'
    ? body.sipPassword
    : existing.sipPassword;
  const line = savePhoneLine({
    id: lineId,
    label: typeof body.label === 'string' ? body.label : existing.label,
    sipUsername: typeof body.sipUsername === 'string' ? body.sipUsername : existing.sipUsername,
    sipPassword,
    sipDomain: typeof body.sipDomain === 'string' ? body.sipDomain : existing.sipDomain,
    did: typeof body.did === 'string' ? body.did : existing.did,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
    status: existing.status,
  });
  if (body.enabled === false) {
    await unregisterLine(lineId);
  }
  sendJson(res, 200, { line: maskPhoneLine(line) });
}

async function handleDeleteLine(_req: IncomingMessage, res: ServerResponse, lineId: string) {
  await unregisterLine(lineId);
  const ok = deletePhoneLine(lineId);
  if (!ok) {
    sendJson(res, 404, { error: 'Line not found' });
    return;
  }
  sendJson(res, 200, { success: true });
}

async function handleTestLine(_req: IncomingMessage, res: ServerResponse, lineId: string) {
  const line = getPhoneLineById(lineId);
  if (!line) {
    sendJson(res, 404, { error: 'Line not found' });
    return;
  }
  const result = await testLineConnection(line);
  sendJson(res, result.ok ? 200 : 400, result);
}

async function handleRegisterAllLines(_req: IncomingMessage, res: ServerResponse) {
  const result = await registerAllEnabledLines();
  sendJson(res, 200, {
    ...result,
    lines: listPhoneLines().map(maskPhoneLine),
  });
}

export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (pathname === '/api/agent/settings' && req.method === 'GET') {
    await handleGetSettings(req, res);
    return true;
  }
  if (pathname === '/api/agent/settings' && req.method === 'PATCH') {
    await handlePatchSettings(req, res);
    return true;
  }
  if (pathname === '/api/agent/status' && req.method === 'GET') {
    await handleGetStatus(req, res);
    return true;
  }
  if (pathname === '/api/agent/voices' && req.method === 'GET') {
    await handleGetVoices(req, res);
    return true;
  }
  if (pathname === '/api/agent/voices' && req.method === 'POST') {
    await handlePostVoice(req, res);
    return true;
  }
  if (pathname === '/api/contacts/lookup' && req.method === 'GET') {
    await handleContactLookup(req, res, url);
    return true;
  }
  if (pathname === '/api/agent/tts' && (req.method === 'GET' || req.method === 'POST')) {
    await handleAgentTts(req, res, url);
    return true;
  }
  if (pathname === '/api/agent/lines' && req.method === 'GET') {
    await handleGetLines(req, res);
    return true;
  }
  if (pathname === '/api/agent/lines' && req.method === 'POST') {
    await handlePostLine(req, res);
    return true;
  }
  if (pathname === '/api/agent/lines/register-all' && req.method === 'POST') {
    await handleRegisterAllLines(req, res);
    return true;
  }
  const lineMatch = pathname.match(/^\/api\/agent\/lines\/([^/]+)(?:\/(test))?$/);
  if (lineMatch) {
    const lineId = decodeURIComponent(lineMatch[1]);
    if (lineMatch[2] === 'test' && req.method === 'POST') {
      await handleTestLine(req, res, lineId);
      return true;
    }
    if (req.method === 'PATCH') {
      await handlePatchLine(req, res, lineId);
      return true;
    }
    if (req.method === 'DELETE') {
      await handleDeleteLine(req, res, lineId);
      return true;
    }
  }
  return false;
}
