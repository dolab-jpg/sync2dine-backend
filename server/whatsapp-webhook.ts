import type { IncomingMessage, ServerResponse } from 'http';
import { createHmac } from 'crypto';
import { handleCyrusViaOrchestrator } from './cyrus-orchestrator';
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

async function sendWhatsAppPayload(
  phoneNumberId: string,
  accessToken: string,
  payload: Record<string, unknown>
): Promise<void> {
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

  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const field = change?.field;

    const phoneNumberId = value?.metadata?.phone_number_id ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
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

    const from = message.from as string;
    const groupId = message.group_id as string | undefined;
    const isGroup = Boolean(groupId);
    updateWhatsAppSession(from, isGroup ? 'group' : 'individual', groupId);

    const builderInbound = findBuilderInboundProject(from);
    if (builderInbound) {
      const inboundText = message.type === 'text'
        ? String(message.text?.body ?? '')
        : `Sent a ${String(message.type ?? 'message')}`;
      await handleBuilderInbound(
        builderInbound.projectId,
        builderInbound.builderName,
        from,
        inboundText
      );
      return;
    }

    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!accessToken || !phoneNumberId) return;

    const resolved = resolveContactByPhone(from);
    let projectId = resolved.projectId;

    if (isGroup && groupId) {
      const groupProject = getProjectByGroupId(groupId);
      if (groupProject) projectId = String(groupProject.id);
    }

    if (message.type === 'image' || message.type === 'document') {
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
            const file = {
              id: `F${Date.now()}`,
              storagePath: `whatsapp/${projectId}/${filename}`,
              filename,
              mimeType: media.mimeType,
              source: 'whatsapp',
              uploadedBy: resolved.contactName,
              takenAt: new Date().toISOString(),
              dataUrl: `data:${media.mimeType};base64,${media.buffer.toString('base64')}`,
            };
            project.files = [...(project.files as unknown[] ?? []), file];
            if (media.mimeType.startsWith('image/')) {
              project.photos = [...(project.photos as string[] ?? []), file.id];
            }
            syncData(store);
          }
        }
      }
      if (message.type === 'image') return;
    }

    if (message.type !== 'text') return;

    const text = message.text?.body as string;
    const upset = /upset|angry|unhappy|complaint|terrible|awful|disappointed/i.test(text);

    if (projectId && upset) {
      const store = getDataStore();
      const project = store.projects.find(p => String(p.id) === projectId);
      if (project) {
        project.escalated = true;
        syncData(store);
      }
    }

    appendProjectMessage(projectId ?? 'unknown', {
      id: `WM${Date.now()}`,
      from: resolved.contactName,
      fromRole: 'customer',
      body: text,
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      senderPhone: from,
      senderContactName: resolved.contactName,
      senderContactRole: resolved.contactRole,
    });

    const store = getDataStore();
    const project = projectId ? store.projects.find(p => String(p.id) === projectId) : null;
    const todayTasks = project
      ? (project.tasks as Array<Record<string, unknown>> ?? [])
          .filter(t => t.status !== 'completed')
          .slice(0, 3)
          .map(t => String(t.title))
      : [];

    const cyrusResult = await handleCyrusViaOrchestrator({
      messages: [{ role: 'user', content: text }],
      customerContext: {
        customerId: resolved.customerId,
        customerName: resolved.customerName,
        phone: from,
        contactName: resolved.contactName,
        contactRole: resolved.contactRole,
        projectId,
        quoteId: project?.quoteId ? String(project.quoteId) : null,
      },
      projectContext: project
        ? {
            projectId: String(project.id),
            projectName: String(project.projectName ?? 'Project'),
            customerId: String(project.customerId ?? ''),
            quoteId: String(project.quoteId ?? ''),
            status: String(project.status ?? 'unknown'),
            todayTasks,
            nextPaymentDue: (() => {
              const stages = (project.paymentStages as Array<Record<string, unknown>> ?? []);
              const due = stages.find(s => s.status === 'due' || s.status === 'pending');
              return due
                ? {
                    name: String(due.name ?? 'Payment stage'),
                    amount: Number(due.amount ?? 0),
                    status: String(due.status ?? 'pending'),
                    dueDate: String(due.dueDate ?? ''),
                  }
                : null;
            })(),
            portalToken: String(project.portalToken ?? ''),
          }
        : undefined,
    });
    const content = cyrusResult.content;

    if (isGroup && groupId) {
      await sendWhatsAppText(phoneNumberId, accessToken, groupId, content, 'group');
    } else {
      await sendWhatsAppText(phoneNumberId, accessToken, from, content);
    }

    if (projectId) {
      appendProjectMessage(projectId, {
        id: `WM${Date.now()}a`,
        from: 'Cyrus',
        fromRole: 'office',
        body: content,
        timestamp: new Date().toISOString(),
        channel: 'whatsapp',
      });
      appendProjectAiAction(projectId, {
        id: `AI${Date.now()}`,
        action: 'cyrusReply',
        input: {
          channel: 'whatsapp',
          senderPhone: from,
          senderContactName: resolved.contactName,
        },
        output: {
          content,
          toolsUsed: cyrusResult.toolsUsed,
        },
        status: 'approved',
        createdAt: new Date().toISOString(),
        approvedBy: 'Cyrus',
      });
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }
}

export async function handleMessageSend(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { channel, to, body: text, config, templateId, templateVars, attachment, groupId } = body;

  if (channel === 'whatsapp') {
    const token = config?.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = config?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneId) {
      sendJson(res, 400, { error: 'WhatsApp not configured' });
      return;
    }

    const inWindow = isWithin24hWindow(to);
    const portalLink = templateVars?.portalLink ?? '';

    if (groupId) {
      await sendWhatsAppText(phoneId, token, groupId, text, 'group');
      sendJson(res, 200, { success: true, mode: 'group' });
      return;
    }

    if (!inWindow && templateId) {
      const vars = templateVars
        ? [templateVars.name ?? '', templateVars.summary ?? portalLink, portalLink].filter(Boolean)
        : [text.slice(0, 100), portalLink];
      await sendWhatsAppTemplate(phoneId, token, to, templateId, vars);
      sendJson(res, 200, { success: true, mode: 'template', templateId });
      return;
    }

    await sendWhatsAppText(phoneId, token, to, text);
    if (attachment?.content && inWindow) {
      await sendWhatsAppPayload(phoneId, token, {
        to: to.replace(/\D/g, ''),
        type: 'document',
        document: {
          link: attachment.url ?? undefined,
          filename: attachment.filename,
          caption: text.slice(0, 100),
        },
      });
    }
    sendJson(res, 200, { success: true, mode: inWindow ? 'session' : 'text' });
    return;
  }

  if (channel === 'email') {
    sendJson(res, 200, { success: true, mock: true, message: 'Email queued (configure SMTP/Resend at go-live)' });
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
