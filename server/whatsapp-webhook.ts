import type { IncomingMessage, ServerResponse } from 'http';
import { createHmac } from 'crypto';
import { handleChannelInbound } from './channel-inbound-handler';
import { getRequestOrgId } from './data-store';
import {
  resolveContactByPhone,
  updateWhatsAppSession,
  isWithin24hWindow,
  getProjectByGroupId,
  getDataStore,
  syncData,
  setRequestOrgId,
} from './data-store';
import { getOrganizationByWhatsAppPhoneNumberId } from './organizations';
import { sendWWebMessage, sendWWebDocument, getWWebStatus } from './whatsapp-web-client';

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

function verifySignature(payload: string, signature: string | undefined, appSecret: string): boolean {
  if (!signature || !appSecret) return !appSecret;
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(payload).digest('hex');
  return signature === expected;
}

/** Path B (Meta Cloud API) — cold forever unless explicitly enabled. Do not enable in production. */
export function isMetaWhatsAppEnabled(): boolean {
  const v = process.env.WHATSAPP_META_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

async function sendWhatsAppPayload(
  phoneNumberId: string,
  accessToken: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!isMetaWhatsAppEnabled()) {
    throw new Error('Meta WhatsApp Cloud API is disabled — use WhatsApp Web (QR) in Integrations');
  }
  await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
}

export async function sendWhatsAppText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string,
  recipientType: 'individual' | 'group' = 'individual'
): Promise<void> {
  await sendWhatsAppPayload(phoneNumberId, accessToken, {
    recipient_type: recipientType,
    to: to.replace(/\D/g, ''),
    type: 'text',
    text: { body: text },
  });
}

export async function sendWhatsAppAudio(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  audioBuffer: Buffer,
  mimeType = 'audio/mpeg'
): Promise<void> {
  if (!isMetaWhatsAppEnabled()) {
    throw new Error('Meta WhatsApp Cloud API is disabled — use WhatsApp Web (QR) in Integrations');
  }
  const uploadRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': mimeType,
    },
    body: new Uint8Array(audioBuffer),
  });
  const upload = await uploadRes.json() as { id?: string };
  if (!upload.id) {
    await sendWhatsAppText(phoneNumberId, accessToken, to, '[Voice reply unavailable — see text above]');
    return;
  }
  await sendWhatsAppPayload(phoneNumberId, accessToken, {
    to: to.replace(/\D/g, ''),
    type: 'audio',
    audio: { id: upload.id },
  });
}

export async function sendWhatsAppTemplate(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  variables: string[]
): Promise<void> {
  await sendWhatsAppPayload(phoneNumberId, accessToken, {
    to: to.replace(/\D/g, ''),
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en_GB' },
      components: variables.length
        ? [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: v })) }]
        : [],
    },
  });
}

async function downloadWhatsAppMedia(
  mediaId: string,
  accessToken: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!isMetaWhatsAppEnabled()) return null;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const meta = await metaRes.json() as { url?: string; mime_type?: string };
    if (!meta.url) return null;
    const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    return { buffer, mimeType: meta.mime_type ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

function appendProjectMessage(
  projectId: string,
  msg: Record<string, unknown>
): void {
  const store = getDataStore();
  const project = store.projects.find(p => String(p.id) === projectId);
  if (!project) return;
  const messages = [...(project.messages as unknown[] ?? []), msg];
  project.messages = messages;
  syncData(store);
}

function appendProjectAiAction(
  projectId: string,
  action: Record<string, unknown>
): void {
  const store = getDataStore();
  const project = store.projects.find(p => String(p.id) === projectId);
  if (!project) return;
  const aiActions = [...(project.aiActions as unknown[] ?? []), action];
  project.aiActions = aiActions;
  syncData(store);
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('44')) return digits;
  if (digits.startsWith('0')) return `44${digits.slice(1)}`;
  return digits;
}

function appendContractorComm(
  projectId: string,
  comm: Record<string, unknown>
): void {
  const store = getDataStore();
  const project = store.projects.find(p => String(p.id) === projectId);
  if (!project) return;
  const contractorComms = [...(project.contractorComms as unknown[] ?? []), comm];
  project.contractorComms = contractorComms;
  syncData(store);
}

function findBuilderInboundProject(fromPhone: string): { projectId: string; builderName: string } | null {
  const store = getDataStore();
  const normalizedFrom = normalizePhone(fromPhone);
  const activeProjects = store.projects.filter((project) => {
    const status = String(project.status ?? '');
    return status !== 'completed' && status !== 'cancelled';
  });

  for (const project of activeProjects) {
    const assignedBuilder = String(project.assignedBuilder ?? '').trim();
    if (!assignedBuilder) continue;
    const match = (store.builders ?? []).find((builder) =>
      String(builder.name ?? '').trim() === assignedBuilder
      && normalizePhone(String(builder.phone ?? '')) === normalizedFrom
    );
    if (match) {
      return {
        projectId: String(project.id),
        builderName: assignedBuilder,
      };
    }
  }

  return null;
}

async function handleBuilderInbound(
  projectId: string,
  builderName: string,
  fromPhone: string,
  text: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  appendProjectMessage(projectId, {
    id: `WM${Date.now()}`,
    from: builderName,
    fromRole: 'builder',
    body: text,
    timestamp,
    channel: 'whatsapp',
    senderPhone: fromPhone,
  });

  appendContractorComm(projectId, {
    id: `CC${Date.now()}`,
    builderId: 'builder',
    builderName,
    subject: 'Builder inbound',
    body: text,
    status: 'replied',
    channel: 'whatsapp',
    createdAt: timestamp,
  });

  const shouldTriggerOrchestrator = process.env.BUILDER_INBOUND_ORCHESTRATE === '1';
  if (!shouldTriggerOrchestrator) return;

  try {
    const store = getDataStore();
    const project = store.projects.find((p) => String(p.id) === projectId);
    const { handleOrchestrator } = await import('./orchestrator-handler');
    const result = await handleOrchestrator({
      orchestratorMode: 'foreman',
      messages: [{ role: 'user', content: text }],
      staffContext: {
        role: 'builder',
        route: '/projects',
      },
      projectContext: {
        projectId,
        projectName: String(project?.projectName ?? 'Project'),
        builderName,
      },
    });

    if (result.content?.trim()) {
      appendProjectMessage(projectId, {
        id: `WM${Date.now()}b`,
        from: 'Cyrus',
        fromRole: 'office',
        body: `Builder triage: ${result.content}`,
        timestamp: new Date().toISOString(),
        channel: 'app',
      });
    }
  } catch (err) {
    console.error('Builder orchestrator trigger failed:', err);
  }
}

export async function handleWhatsAppWebhookGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) {
  // Path B cold forever — do not complete Meta hub verification in production
  if (!isMetaWhatsAppEnabled()) {
    sendJson(res, 403, { error: 'Meta WhatsApp webhook disabled — use WhatsApp Web (QR)' });
    return;
  }
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? 'tradepro_verify';

  if (mode === 'subscribe' && token === verifyToken && challenge) {
    res.statusCode = 200;
    res.end(challenge);
    return;
  }
  sendJson(res, 403, { error: 'Verification failed' });
}

export async function handleWhatsAppWebhookPost(
  req: IncomingMessage,
  res: ServerResponse
) {
  // Path B cold forever — ack empty so accidental Meta posts do nothing
  if (!isMetaWhatsAppEnabled()) {
    await readBody(req);
    res.statusCode = 200;
    res.end('OK');
    return;
  }

  const rawBody = await readBody(req);
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const appSecret = process.env.META_APP_SECRET ?? '';

  if (!verifySignature(rawBody, signature, appSecret)) {
    sendJson(res, 401, { error: 'Invalid signature' });
    return;
  }

  const body = JSON.parse(rawBody);
  res.statusCode = 200;
  res.end('OK');

  let from: string | undefined;
  let phoneNumberId: string | undefined;
  let accessToken: string | undefined;
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const field = change?.field;

    phoneNumberId = value?.metadata?.phone_number_id ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (phoneNumberId) {
      const org = getOrganizationByWhatsAppPhoneNumberId(String(phoneNumberId));
      setRequestOrgId(org?.id ?? 'default');
    }

    if (field?.startsWith('group_')) {
      console.log('WhatsApp group event:', field, JSON.stringify(value).slice(0, 200));
      return;
    }

    const message = value?.messages?.[0];
    if (!message) return;

    from = typeof message.from === 'string' ? message.from : undefined;
    if (!from) return;
    const groupId = message.group_id as string | undefined;
    const isGroup = Boolean(groupId);
    updateWhatsAppSession(from, isGroup ? 'group' : 'individual', groupId);

    accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!accessToken || !phoneNumberId) return;

    const builderInbound = findBuilderInboundProject(from);

    const resolved = resolveContactByPhone(from);
    let projectId = builderInbound?.projectId ?? resolved.projectId;

    if (isGroup && groupId) {
      const groupProject = getProjectByGroupId(groupId);
      if (groupProject) projectId = String(groupProject.id);
    }

    let text = '';
    if (message.type === 'text') {
      text = String(message.text?.body ?? '');
    } else if (message.type === 'audio') {
      const mediaId = message.audio?.id;
      if (mediaId && accessToken) {
        const media = await downloadWhatsAppMedia(mediaId, accessToken);
        if (media) {
          try {
            const { resolveOpenAIApiKeyAsync } = await import('./openai-connection');
            const { default: OpenAI } = await import('openai');
            const waOrgId = getRequestOrgId();
            const openai = new OpenAI({ apiKey: await resolveOpenAIApiKeyAsync(undefined, waOrgId) });
            const file = new File([new Uint8Array(media.buffer)], 'voice.ogg', { type: media.mimeType });
            const transcript = await openai.audio.transcriptions.create({
              model: 'whisper-1',
              file,
            });
            text = transcript.text ?? '';
          } catch {
            text = '[Voice note received — could not transcribe]';
          }
        }
      }
    } else if (message.type === 'image' || message.type === 'document') {
      const mediaId = message.image?.id ?? message.document?.id;
      if (mediaId && projectId) {
        const media = await downloadWhatsAppMedia(mediaId, accessToken);
        const filename = message.document?.filename ?? `whatsapp_${Date.now()}.jpg`;
        appendProjectMessage(projectId, {
          id: `WM${Date.now()}`,
          from: resolved.contactName,
          fromRole: 'customer',
          body: `Sent a ${message.type}`,
          timestamp: new Date().toISOString(),
          channel: 'whatsapp',
          senderPhone: from,
          senderContactName: resolved.contactName,
          senderContactRole: resolved.contactRole,
          attachments: [filename],
        });
        if (media) {
          const store = getDataStore();
          const project = store.projects.find(p => String(p.id) === projectId);
          if (project) {
            const storagePath = `whatsapp/${projectId}/${filename}`;
            const fileId = `F${Date.now()}`;
            let file: Record<string, unknown> = {
              id: fileId,
              storagePath,
              filename,
              mimeType: media.mimeType,
              source: 'whatsapp',
              uploadedBy: resolved.contactName,
              takenAt: new Date().toISOString(),
              dataUrl: `data:${media.mimeType};base64,${media.buffer.toString('base64')}`,
            };

            try {
              const { uploadProjectMedia, isSupabaseStorageConfigured } = await import('./storage.js');
              if (isSupabaseStorageConfigured()) {
                const stored = await uploadProjectMedia({
                  orgId: getRequestOrgId(),
                  projectId,
                  relativePath: storagePath,
                  filename,
                  mimeType: media.mimeType,
                  buffer: media.buffer,
                  source: 'whatsapp',
                  uploadedBy: resolved.contactName,
                  fileId,
                });
                if (stored) {
                  file = {
                    id: stored.id,
                    storagePath: stored.storagePath,
                    filename: stored.filename,
                    mimeType: stored.mimeType,
                    source: stored.source,
                    uploadedBy: stored.uploadedBy,
                    takenAt: stored.takenAt,
                  };
                }
              }
            } catch (err) {
              console.warn('[whatsapp] Supabase media upload failed, keeping dataUrl fallback', err);
            }

            project.files = [...(project.files as unknown[] ?? []), file];
            if (media.mimeType.startsWith('image/')) {
              project.photos = [...(project.photos as string[] ?? []), file.id as string];
            }
            syncData(store);
          }
        }
      }
      if (message.type === 'image') {
        if (!text) text = 'Customer sent a photo — please summarise progress or extras.';
      } else if (message.type === 'document') {
        if (!text) text = 'Customer sent a document.';
      }
    }

    if (!text) return;

    if (builderInbound) {
      const timestamp = new Date().toISOString();
      appendProjectMessage(builderInbound.projectId, {
        id: `WM${Date.now()}`,
        from: builderInbound.builderName,
        fromRole: 'builder',
        body: text,
        timestamp,
        channel: 'whatsapp',
        senderPhone: from,
      });
      appendContractorComm(builderInbound.projectId, {
        id: `CC${Date.now()}`,
        builderId: 'builder',
        builderName: builderInbound.builderName,
        subject: 'Builder inbound',
        body: text,
        status: 'replied',
        channel: 'whatsapp',
        createdAt: timestamp,
      });
    }

    appendProjectMessage(projectId ?? 'unknown', {
      id: `WM${Date.now()}`,
      from: resolved.contactName,
      fromRole: resolved.contactRole ?? 'customer',
      body: text,
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      senderPhone: from,
      senderContactName: resolved.contactName,
      senderContactRole: resolved.contactRole,
    });

    const orgId = getRequestOrgId();
    const inbound = await handleChannelInbound({
      orgId,
      phone: from,
      text,
      channel: 'whatsapp',
      contactName: resolved.contactName,
      projectId: projectId ?? resolved.projectId,
    });

    const replyText = inbound.replyLocalized || inbound.replyEnglish;
    const voicePreset = process.env.WHATSAPP_VOICE_REPLY === '1';

    if (isGroup && groupId) {
      await sendWhatsAppText(phoneNumberId, accessToken, groupId, replyText, 'group');
    } else {
      await sendWhatsAppText(phoneNumberId, accessToken, from, replyText);
      if (voicePreset && inbound.route.mode === 'staff') {
        try {
          const { synthesizeSpeech } = await import('./tts');
          const tts = await synthesizeSpeech(inbound.replyEnglish.slice(0, 500));
          await sendWhatsAppAudio(phoneNumberId, accessToken, from, tts.buffer, tts.contentType);
        } catch {
          // text-only fallback
        }
      }
    }

    if (projectId) {
      appendProjectMessage(projectId, {
        id: `WM${Date.now()}a`,
        from: inbound.route.mode === 'staff' ? 'Cynthia' : 'Cyrus',
        fromRole: 'office',
        body: inbound.replyEnglish,
        bodyEnglish: inbound.replyEnglish,
        timestamp: new Date().toISOString(),
        channel: 'whatsapp',
      });
      appendProjectAiAction(projectId, {
        id: `AI${Date.now()}`,
        action: 'channelInbound',
        input: { channel: 'whatsapp', route: inbound.route.mode, phone: from },
        output: { executed: inbound.executedSummaries, toolsUsed: inbound.toolsUsed },
        status: 'approved',
        createdAt: new Date().toISOString(),
        approvedBy: 'Channel AI',
      });
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
    try {
      const { OpenAIConnectionError } = await import('./openai-connection');
      if (err instanceof OpenAIConnectionError && from && phoneNumberId && accessToken) {
        await sendWhatsAppText(
          phoneNumberId,
          accessToken,
          from,
          'Sorry — our AI assistant is temporarily unavailable. A team member will follow up shortly.',
        );
      }
    } catch {
      // ignore secondary failures
    }
  }
}

export async function handleMessageSend(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { channel, to, body: text, config, templateId, templateVars, attachment, groupId, sourceLang } = body;

  if (channel === 'whatsapp') {
    const { ensureEnglishForCustomerSend } = await import('./outbound-english-guard');
    const guard = await ensureEnglishForCustomerSend(String(text ?? ''), sourceLang, getRequestOrgId());
    if (!guard.ok) {
      sendJson(res, 502, { success: false, error: 'Could not translate message to English before sending — message was not sent.' });
      return;
    }
    const englishText = guard.english;

    // WhatsApp Web.js is the sole live transport (Path B Meta cold forever)
    if (getWWebStatus() === 'ready') {
      const target = groupId || to;
      const msgId = await sendWWebMessage(target, englishText);
      if (!msgId) {
        sendJson(res, 500, { success: false, error: 'WhatsApp Web send failed' });
        return;
      }
      if (attachment?.content) {
        const buf = Buffer.from(attachment.content, 'base64');
        await sendWWebDocument(to, buf, attachment.mimeType || 'application/pdf', attachment.filename || 'document.pdf', englishText.slice(0, 100));
      }
      sendJson(res, 200, { success: true, mode: 'wweb', messageId: msgId });
      return;
    }

    // Retained Meta fallback — only when WHATSAPP_META_ENABLED is explicitly on (never in production)
    if (isMetaWhatsAppEnabled()) {
      const token = config?.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
      const phoneId = config?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
      if (token && phoneId) {
        const inWindow = isWithin24hWindow(to);
        const portalLink = templateVars?.portalLink ?? '';

        if (groupId) {
          await sendWhatsAppText(phoneId, token, groupId, englishText, 'group');
          sendJson(res, 200, { success: true, mode: 'group' });
          return;
        }

        if (!inWindow && templateId) {
          const vars = templateVars
            ? [templateVars.name ?? '', templateVars.summary ?? portalLink, portalLink].filter(Boolean)
            : [englishText.slice(0, 100), portalLink];
          await sendWhatsAppTemplate(phoneId, token, to, templateId, vars);
          sendJson(res, 200, { success: true, mode: 'template', templateId });
          return;
        }

        await sendWhatsAppText(phoneId, token, to, englishText);
        if (attachment?.content && inWindow) {
          // Prefer hosted URL; otherwise skip Meta document (WWeb path handles base64)
          const link = typeof attachment.url === 'string' && /^https?:\/\//i.test(attachment.url)
            ? attachment.url
            : undefined;
          if (link) {
            await sendWhatsAppPayload(phoneId, token, {
              to: to.replace(/\D/g, ''),
              type: 'document',
              document: {
                link,
                filename: attachment.filename,
                caption: englishText.slice(0, 100),
              },
            });
          }
        }
        sendJson(res, 200, { success: true, mode: inWindow ? 'session' : 'text' });
        return;
      }
    }

    sendJson(res, 400, { error: 'WhatsApp not configured — connect via QR code in Integrations' });
    return;
  }

  if (channel === 'email') {
    const { sendViaSmtp } = await import('./messages-routes');
    const toAddr = to;
    if (!toAddr) {
      sendJson(res, 400, { error: 'No recipient for email' });
      return;
    }
    try {
      const result = await sendViaSmtp({
        to: toAddr,
        subject: body.subject || '(no subject)',
        body: text || '',
        attachment: attachment,
        config: config,
        sourceLang,
      }, toAddr);
      sendJson(res, result.success ? 200 : 500, result);
    } catch (err) {
      sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Email send failed' });
    }
    return;
  }

  sendJson(res, 400, { error: 'Unknown channel' });
}

export async function handleWhatsAppRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL
) {
  if (pathname === '/webhooks/whatsapp' && req.method === 'GET') {
    await handleWhatsAppWebhookGet(req, res, url);
    return true;
  }
  if (pathname === '/webhooks/whatsapp' && req.method === 'POST') {
    await handleWhatsAppWebhookPost(req, res);
    return true;
  }
  if (pathname === '/api/messages/send' && req.method === 'POST') {
    await handleMessageSend(req, res);
    return true;
  }
  if (pathname === '/api/integrations/test' && req.method === 'POST') {
    const { handleIntegrationTest } = await import('./integrations-test');
    const body = JSON.parse(await readBody(req));
    await handleIntegrationTest(req, res, body);
    return true;
  }
  if (pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, { status: 'ok' });
    return true;
  }
  return false;
}
