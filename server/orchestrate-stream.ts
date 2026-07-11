import type { IncomingMessage, ServerResponse } from 'http';
import { handleOrchestrator, type OrchestratorRequest } from './orchestrator-handler';
import { executeChannelActions } from './channel-action-executor';

function sendSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function handleOrchestrateStream(
  req: IncomingMessage,
  res: ServerResponse,
  body: OrchestratorRequest & { orgId?: string; phone?: string; executeOnServer?: boolean }
): Promise<void> {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    sendSse(res, 'status', { phase: 'thinking' });
    const result = await handleOrchestrator(body);
    const allActions = [...result.proposedActions, ...(result.autoActions ?? [])];

    for (const action of allActions) {
      sendSse(res, 'tool', { action: action.action, status: 'running' });
    }

    let executedSummaries: string[] = [];
    if (body.executeOnServer && body.phone && body.orgId) {
      const executed = await executeChannelActions(allActions, {
        role: (body.staffContext?.role as 'staff') ?? 'staff',
        orgId: body.orgId,
        phone: body.phone,
        approvedBy: body.staffContext?.userName,
        orchestratorBody: body,
      });
      executedSummaries = executed.filter((e) => e.executed).map((e) => e.summary);
      for (const e of executed) {
        sendSse(res, 'tool', { action: e.action, status: e.executed ? 'done' : 'skipped', summary: e.summary });
      }
    }

    const chunks = (result.content ?? '').split(/(?<=[.!?])\s+/);
    for (const chunk of chunks) {
      if (chunk.trim()) {
        sendSse(res, 'token', { text: chunk + ' ' });
      }
    }

    sendSse(res, 'done', {
      content: result.content,
      proposedActions: result.proposedActions,
      autoActions: result.autoActions,
      executedSummaries,
      phase: result.phase,
    });
    res.end();
  } catch (err) {
    sendSse(res, 'error', { message: err instanceof Error ? err.message : String(err) });
    res.end();
  }
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer: Buffer, boundary: string): Map<string, { filename?: string; data: Buffer; contentType?: string }> {
  const parts = new Map<string, { filename?: string; data: Buffer; contentType?: string }>();
  const delim = `--${boundary}`;
  const sections = buffer.toString('binary').split(delim).slice(1, -1);
  for (const section of sections) {
    const headerEnd = section.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = section.slice(0, headerEnd);
    const body = section.slice(headerEnd + 4, section.length - 2);
    const nameMatch = /name="([^"]+)"/.exec(headers);
    const fileMatch = /filename="([^"]+)"/.exec(headers);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
    if (nameMatch) {
      parts.set(nameMatch[1], {
        filename: fileMatch?.[1],
        data: Buffer.from(body, 'binary'),
        contentType: typeMatch?.[1],
      });
    }
  }
  return parts;
}

export async function handleTranscribeUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const contentType = req.headers['content-type'] ?? '';
  let audioBuffer: Buffer | null = null;
  let mimeType = 'audio/webm';

  if (contentType.includes('multipart/form-data')) {
    const boundary = /boundary=(.+)/i.exec(contentType)?.[1]?.trim();
    if (!boundary) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Missing boundary' }));
      return;
    }
    const raw = await readRawBody(req);
    const parts = parseMultipart(raw, boundary);
    const filePart = parts.get('file') ?? parts.get('audio') ?? [...parts.values()][0];
    if (filePart) {
      audioBuffer = filePart.data;
      mimeType = filePart.contentType ?? mimeType;
    }
  } else {
    const raw = await readRawBody(req);
    try {
      const json = JSON.parse(raw.toString('utf8')) as { audio?: string; mimeType?: string };
      if (json.audio) {
        audioBuffer = Buffer.from(json.audio, 'base64');
        mimeType = json.mimeType ?? mimeType;
      }
    } catch {
      audioBuffer = raw;
    }
  }

  if (!audioBuffer?.length) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'No audio provided' }));
    return;
  }

  const { resolveOpenAIApiKey } = await import('./openai-connection');
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: resolveOpenAIApiKey() });
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
  const file = new File([audioBuffer], `upload.${ext}`, { type: mimeType });
  const transcript = await openai.audio.transcriptions.create({ model: 'whisper-1', file });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ text: transcript.text ?? '' }));
}
