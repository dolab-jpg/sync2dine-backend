/**
 * WhatsApp Web.js singleton client.
 * Connects via QR code (personal WhatsApp), replaces Meta Cloud API transport.
 * Reuses the existing channel-inbound-handler pipeline for AI + tools.
 */
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia, MessageAck } = pkg;
type WAClient = InstanceType<typeof Client>;
type WAMessage = Awaited<ReturnType<WAClient['sendMessage']>>;

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rm } from 'fs/promises';
import { execSync } from 'child_process';
import { handleChannelInbound } from './channel-inbound-handler';
import {
  resolveContactByPhone,
  getProjectByGroupId,
  getDataStore,
  getRequestOrgId,
  setRequestOrgId,
  syncData,
  DEFAULT_ORG_ID,
} from './data-store';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const AUTH_DATA_PATH = join(DATA_DIR, '.wwebjs_auth');

/** Current WhatsApp Web HTML pin; override with WA_WEB_VERSION_URL on VPS. */
const DEFAULT_WA_WEB_VERSION_URL =
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1043363706-alpha.html';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type WWebStatus =
  | 'disconnected'
  | 'initializing'
  | 'qr_pending'
  | 'authenticated'
  | 'ready'
  | 'error';

export interface InitWWebOptions {
  /** Keep Chromium available for screencast login UI. */
  browserLogin?: boolean;
  /** Internal: already attempted orphan-chrome recovery once. */
  _orphanRetry?: boolean;
}

interface ReadReceipt {
  messageId: string;
  chatId: string;
  ack: number;
  timestamp: string;
}

let client: WAClient | null = null;
let currentStatus: WWebStatus = 'disconnected';
let currentQR: string | null = null;
let lastError: string | null = null;
let clientInfo: Record<string, unknown> | null = null;
let initInFlight: Promise<void> | null = null;
const readReceipts = new Map<string, ReadReceipt>();

export function getWWebStatus(): WWebStatus {
  return currentStatus;
}

export function getWWebQR(): string | null {
  return currentQR;
}

export function getWWebInfo(): Record<string, unknown> | null {
  return clientInfo;
}

export function getWWebClient(): WAClient | null {
  return client;
}

export function getWWebLastError(): string | null {
  return lastError;
}

/** Status payload helper used by /api/whatsapp-web/status debug field. */
export function getWWebDebug(): Record<string, unknown> {
  return {
    status: currentStatus,
    hasClient: Boolean(client),
    canSend: Boolean(client) && currentStatus === 'ready',
    authDataPath: AUTH_DATA_PATH,
    lastError,
    info: clientInfo,
    sessionBrowserSkippedReinit: currentStatus === 'ready' && !client,
  };
}

/** Kill orphan Chromium that still holds Sync2Dine LocalAuth (not TradePro). */
function killOrphanSync2DineWWebChrome(): void {
  const marker = AUTH_DATA_PATH.replace(/\\/g, '/');
  try {
    if (process.platform === 'win32') return;
    execSync(
      `pkill -f "user-data-dir=${marker}" 2>/dev/null || true`,
      { stdio: 'ignore' },
    );
  } catch {
    /* ignore */
  }
}

/** Clear Chromium singleton locks so LocalAuth can reopen the saved session. */
function clearWWebSingletonLocks(): void {
  try {
    if (process.platform === 'win32') return;
    execSync(
      `find "${AUTH_DATA_PATH}" -name 'Singleton*' -type f -delete 2>/dev/null || true`,
      { stdio: 'ignore' },
    );
  } catch {
    /* ignore */
  }
}

function reclaimSync2DineWWebSession(): void {
  killOrphanSync2DineWWebChrome();
  clearWWebSingletonLocks();
}

export function getWWebAuthDataPath(): string {
  return AUTH_DATA_PATH;
}

export function getWWebPupPage(): unknown | null {
  return (client as { pupPage?: unknown } | null)?.pupPage ?? null;
}

function resolveWebVersionCache(): { type: 'remote'; remotePath: string } {
  const remotePath =
    process.env.WA_WEB_VERSION_URL?.trim() || DEFAULT_WA_WEB_VERSION_URL;
  return { type: 'remote', remotePath };
}

function resolvePuppeteerOptions(browserLogin?: boolean) {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;
  return {
    headless: true as boolean,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,800',
      ...(browserLogin ? ['--remote-debugging-port=0'] : []),
    ],
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export function getReadReceipts(chatId?: string): ReadReceipt[] {
  const all = Array.from(readReceipts.values());
  if (!chatId) return all;
  return all.filter(r => r.chatId === chatId);
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('44')) return digits;
  if (digits.startsWith('0')) return `44${digits.slice(1)}`;
  return digits;
}

function appendProjectMessage(
  projectId: string,
  msg: Record<string, unknown>,
  orgId?: string
): void {
  const store = getDataStore(orgId);
  const project = store.projects.find(p => String(p.id) === projectId);
  if (!project) return;
  const messages = [...(project.messages as unknown[] ?? []), msg];
  project.messages = messages;
  syncData(store, orgId);
}

function appendProjectAiAction(
  projectId: string,
  action: Record<string, unknown>,
  orgId?: string
): void {
  const store = getDataStore(orgId);
  const project = store.projects.find(p => String(p.id) === projectId);
  if (!project) return;
  const aiActions = [...(project.aiActions as unknown[] ?? []), action];
  project.aiActions = aiActions;
  syncData(store, orgId);
}

async function handleIncomingMessage(msg: WAMessage): Promise<void> {
  try {
    if (msg.fromMe) return;

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    const from = msg.author || msg.from;
    const phone = normalizePhone(from.replace('@c.us', '').replace('@g.us', ''));

    const orgId = DEFAULT_ORG_ID;
    setRequestOrgId(orgId);

    const resolved = resolveContactByPhone(phone);
    let projectId = resolved.projectId;

    if (isGroup) {
      const groupProject = getProjectByGroupId(chat.id._serialized);
      if (groupProject) projectId = String(groupProject.id);
    }

    let text = '';

    if (msg.type === 'chat') {
      text = msg.body || '';
    } else if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (media) {
        const isAudio = media.mimetype.startsWith('audio/') || msg.type === 'ptt';
        const isImage = media.mimetype.startsWith('image/');
        const isDocument = media.mimetype.startsWith('application/');

        if (isAudio) {
          try {
            const { resolveOpenAIApiKeyAsync } = await import('./openai-connection');
            const { default: OpenAI } = await import('openai');
            const openai = new OpenAI({ apiKey: await resolveOpenAIApiKeyAsync(undefined, orgId) });
            const buffer = Buffer.from(media.data, 'base64');
            const file = new File([buffer], 'voice.ogg', { type: media.mimetype });
            const transcript = await openai.audio.transcriptions.create({
              model: 'whisper-1',
              file,
            });
            text = transcript.text ?? '';
          } catch {
            text = '[Voice note received — could not transcribe]';
          }
        }

        if ((isImage || isDocument) && projectId) {
          const ext = media.mimetype.split('/')[1]?.split(';')[0] ?? 'bin';
          const filename = (msg as any).filename || `whatsapp_${Date.now()}.${ext}`;

          appendProjectMessage(projectId, {
            id: `WM${Date.now()}`,
            from: resolved.contactName,
            fromRole: 'customer',
            body: `Sent a ${isImage ? 'photo' : 'document'}`,
            timestamp: new Date().toISOString(),
            channel: 'whatsapp',
            senderPhone: phone,
            senderContactName: resolved.contactName,
            senderContactRole: resolved.contactRole,
            attachments: [filename],
          }, orgId);

          const store = getDataStore(orgId);
          const project = store.projects.find(p => String(p.id) === projectId);
          if (project) {
            const fileRecord = {
              id: `F${Date.now()}`,
              storagePath: `whatsapp/${projectId}/${filename}`,
              filename,
              mimeType: media.mimetype,
              source: 'whatsapp',
              uploadedBy: resolved.contactName,
              takenAt: new Date().toISOString(),
              dataUrl: `data:${media.mimetype};base64,${media.data}`,
            };
            project.files = [...(project.files as unknown[] ?? []), fileRecord];
            if (isImage) {
              project.photos = [...(project.photos as string[] ?? []), fileRecord.id];
            }
            syncData(store, orgId);
          }

          if (!text) {
            text = isImage
              ? 'Customer sent a photo — please summarise progress or extras.'
              : 'Customer sent a document.';
          }
        }
      }
    }

    if (!text) return;

    appendProjectMessage(projectId ?? 'unknown', {
      id: `WM${Date.now()}`,
      from: resolved.contactName,
      fromRole: resolved.contactRole ?? 'customer',
      body: text,
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      senderPhone: phone,
      senderContactName: resolved.contactName,
      senderContactRole: resolved.contactRole,
    }, orgId);

    const inbound = await handleChannelInbound({
      orgId,
      phone,
      text,
      channel: 'whatsapp',
      contactName: resolved.contactName,
      projectId: projectId ?? resolved.projectId,
    });

    const replyText = inbound.replyLocalized || inbound.replyEnglish;

    if (isGroup) {
      await chat.sendMessage(replyText);
    } else {
      await msg.reply(replyText);
    }

    if (projectId) {
      appendProjectMessage(projectId, {
        id: `WM${Date.now()}a`,
        from: inbound.route.mode === 'staff' ? 'Cynthia' : 'Cynthia',
        fromRole: 'office',
        body: inbound.replyEnglish,
        bodyEnglish: inbound.replyEnglish,
        timestamp: new Date().toISOString(),
        channel: 'whatsapp',
      }, orgId);

      appendProjectAiAction(projectId, {
        id: `AI${Date.now()}`,
        action: 'channelInbound',
        input: { channel: 'whatsapp', route: inbound.route.mode, phone },
        output: { executed: inbound.executedSummaries, toolsUsed: inbound.toolsUsed },
        status: 'approved',
        createdAt: new Date().toISOString(),
        approvedBy: 'Channel AI',
      }, orgId);
    }
  } catch (err) {
    console.error('WhatsApp Web.js inbound error:', err);
    try {
      const chat = await msg.getChat();
      await chat.sendMessage(
        'Sorry — our AI assistant is temporarily unavailable. A team member will follow up shortly.'
      );
    } catch {
      // ignore secondary failures
    }
  }
}

export async function wipeWWebAuthData(): Promise<void> {
  try {
    await rm(AUTH_DATA_PATH, { recursive: true, force: true });
    console.log('WhatsApp Web.js auth data wiped:', AUTH_DATA_PATH);
  } catch (err) {
    console.warn('WhatsApp Web.js auth wipe failed:', err);
  }
}

/** Force-destroy client even when stuck mid-init (does not wipe auth files). */
export async function destroyWWeb(): Promise<void> {
  const existing = client;
  client = null;
  initInFlight = null;
  currentStatus = 'disconnected';
  currentQR = null;
  clientInfo = null;
  readReceipts.clear();

  if (!existing) return;

  try {
    await Promise.race([
      (async () => {
        try {
          await existing.logout();
        } catch {
          /* already gone */
        }
        try {
          await existing.destroy();
        } catch {
          /* ignore */
        }
      })(),
      sleep(8000),
    ]);
  } catch {
    /* ignore */
  }
  console.log('WhatsApp Web.js client destroyed');
}

export async function logoutWWeb(): Promise<void> {
  await destroyWWeb();
  console.log('WhatsApp Web.js logged out');
}

export async function reconnectWWeb(opts?: { fresh?: boolean }): Promise<void> {
  await destroyWWeb();
  if (opts?.fresh) {
    await wipeWWebAuthData();
  }
  lastError = null;
  void initWWebClient();
}

export async function initWWebClient(options?: InitWWebOptions): Promise<void> {
  if (client && currentStatus === 'ready') {
    console.log('WhatsApp Web.js client already ready');
    return;
  }
  if (initInFlight) {
    return initInFlight;
  }
  if (client) {
    console.log('WhatsApp Web.js replacing non-ready client...');
    await destroyWWeb();
  }

  initInFlight = (async () => {
    console.log('Initializing WhatsApp Web.js client...');
    currentStatus = 'initializing';
    lastError = null;
    currentQR = null;
    clientInfo = null;

    // Free prior-process Chromium before first launch so LocalAuth can restore session.
    reclaimSync2DineWWebSession();
    await sleep(1200);
    // #region agent log
    void import('./debug-session-log').then(({ debugLog }) => {
      debugLog('D', 'whatsapp-web-client.ts:init', 'pre-init reclaim done', {
        authDataPath: AUTH_DATA_PATH,
      }, 'post-fix');
    }).catch(() => {});
    // #endregion

    const webVersionCache = resolveWebVersionCache();
    console.log('WhatsApp Web version cache:', webVersionCache.remotePath);

    const wireClientEvents = (c: WAClient) => {
      c.on('qr', (qr: string) => {
        currentStatus = 'qr_pending';
        currentQR = qr;
        lastError = null;
        console.log('WhatsApp QR code received — scan from admin panel or terminal:');
        try {
          import('qrcode-terminal').then((m) => m.default.generate(qr, { small: true }));
        } catch {
          console.log('QR:', qr);
        }
      });
      c.on('authenticated', () => {
        currentStatus = 'authenticated';
        currentQR = null;
        lastError = null;
        console.log('WhatsApp Web.js authenticated');
      });
      c.on('ready', () => {
        currentStatus = 'ready';
        currentQR = null;
        lastError = null;
        if (client) {
          const info = (client as any).info;
          clientInfo = info
            ? {
                pushname: info.pushname,
                wid: info.wid?._serialized,
                platform: info.platform,
                phone: info.wid?.user,
              }
            : null;
        }
        console.log('WhatsApp Web.js client ready:', JSON.stringify(clientInfo));
        // #region agent log
        void import('./debug-session-log').then(({ debugLog }) => {
          debugLog('D', 'whatsapp-web-client.ts:ready', 'client ready', {
            hasClient: Boolean(client),
            canSend: Boolean(client) && currentStatus === 'ready',
            phone: clientInfo?.phone ?? null,
          }, 'post-fix');
        }).catch(() => {});
        // #endregion
      });
      c.on('auth_failure', (errMsg: string) => {
        currentStatus = 'error';
        currentQR = null;
        clientInfo = null;
        lastError = `Auth failure: ${errMsg}`;
        console.error('WhatsApp Web.js auth failure:', errMsg);
      });
      c.on('disconnected', (reason: string) => {
        currentStatus = 'disconnected';
        currentQR = null;
        clientInfo = null;
        lastError = `Disconnected: ${reason}`;
        console.log('WhatsApp Web.js disconnected:', reason);
      });
      c.on('message', (msg: WAMessage) => {
        void handleIncomingMessage(msg);
      });
      c.on('message_ack', (msg: WAMessage, ack: number) => {
        readReceipts.set(msg.id._serialized, {
          messageId: msg.id._serialized,
          chatId: msg.from,
          ack,
          timestamp: new Date().toISOString(),
        });
      });
    };

    client = new Client({
      authStrategy: new LocalAuth({
        dataPath: AUTH_DATA_PATH,
      }),
      puppeteer: resolvePuppeteerOptions(options?.browserLogin),
      userAgent: CHROME_UA,
      webVersionCache,
    } as any);
    wireClientEvents(client);

    try {
      await client.initialize();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Orphan Chromium from a prior API process still holds LocalAuth — free it and retry once.
      if (/browser is already running/i.test(msg) && !options?._orphanRetry) {
        // #region agent log
        void import('./debug-session-log').then(({ debugLog }) => {
          debugLog('D', 'whatsapp-web-client.ts:init', 'orphan chrome — kill + retry', {
            authDataPath: AUTH_DATA_PATH,
          }, 'post-fix');
        }).catch(() => {});
        // #endregion
        console.log(
          'WhatsApp Web.js orphan session browser detected — freeing Sync2Dine auth dir and re-attaching',
        );
        const failed = client;
        client = null;
        if (failed) {
          try { await failed.destroy(); } catch { /* ignore */ }
        }
        reclaimSync2DineWWebSession();
        await sleep(1500);
        currentStatus = 'initializing';
        client = new Client({
          authStrategy: new LocalAuth({ dataPath: AUTH_DATA_PATH }),
          puppeteer: resolvePuppeteerOptions(options?.browserLogin),
          userAgent: CHROME_UA,
          webVersionCache,
        } as any);
        wireClientEvents(client);
        try {
          await client.initialize();
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error('WhatsApp Web.js re-attach failed:', retryErr);
          currentStatus = 'error';
          lastError = `Re-attach failed: ${retryMsg}`;
          const failedRetry = client;
          client = null;
          if (failedRetry) {
            try { await failedRetry.destroy(); } catch { /* ignore */ }
          }
        }
      } else if (/browser is already running/i.test(msg)) {
        currentStatus = 'error';
        lastError = 'Session browser still locked after orphan kill — manual reconnect needed';
        client = null;
        console.error('WhatsApp Web.js still locked after orphan recovery');
      } else {
        console.error('WhatsApp Web.js failed to initialize:', err);
        currentStatus = 'error';
        lastError = `Init failed: ${msg}`;
        const failed = client;
        client = null;
        if (failed) {
          try {
            await failed.destroy();
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      initInFlight = null;
      // #region agent log
      void import('./debug-session-log').then(({ debugLog }) => {
        debugLog('D', 'whatsapp-web-client.ts:init:finally', 'init settled', {
          status: currentStatus,
          hasClient: Boolean(client),
          canSend: Boolean(client) && currentStatus === 'ready',
          lastError,
        }, 'post-fix');
      }).catch(() => {});
      // #endregion
    }
  })();

  return initInFlight;
}

export async function sendWWebMessage(
  to: string,
  body: string,
  options?: { media?: { data: string; mimetype: string; filename?: string } }
): Promise<string | null> {
  // #region agent log
  void import('./debug-session-log').then(({ debugLog }) => {
    debugLog('D', 'whatsapp-web-client.ts:sendWWebMessage', 'send gate', {
      status: currentStatus,
      hasClient: Boolean(client),
      sessionBrowserSkippedReinit: currentStatus === 'ready' && !client,
      wouldBlock: !client || currentStatus !== 'ready',
      canSend: Boolean(client) && currentStatus === 'ready',
    }, 'post-fix');
  }).catch(() => {});
  // #endregion
  if (!client || currentStatus !== 'ready') {
    console.error('WhatsApp Web.js not ready — cannot send');
    return null;
  }

  const chatId = to.includes('@') ? to : `${normalizePhone(to)}@c.us`;

  try {
    if (options?.media) {
      const media = new MessageMedia(
        options.media.mimetype,
        options.media.data,
        options.media.filename
      );
      const sent = await client.sendMessage(chatId, media, { caption: body || undefined });
      return sent.id._serialized;
    }

    const sent = await client.sendMessage(chatId, body);
    return sent.id._serialized;
  } catch (err) {
    console.error('WhatsApp Web.js send error:', err);
    return null;
  }
}

export async function sendWWebDocument(
  to: string,
  fileBuffer: Buffer,
  mimetype: string,
  filename: string,
  caption?: string
): Promise<string | null> {
  const base64 = fileBuffer.toString('base64');
  return sendWWebMessage(to, caption || '', {
    media: { data: base64, mimetype, filename },
  });
}

export async function sendWWebImage(
  to: string,
  imageBuffer: Buffer,
  mimetype: string,
  caption?: string
): Promise<string | null> {
  const base64 = imageBuffer.toString('base64');
  return sendWWebMessage(to, caption || '', {
    media: { data: base64, mimetype, filename: `image_${Date.now()}.${mimetype.split('/')[1] || 'jpg'}` },
  });
}

export { MessageMedia };
