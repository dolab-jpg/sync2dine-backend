/**
 * Embedded Chromium login for WhatsApp Web.
 * Streams CDP screencast frames so Integrations can show real WhatsApp Web
 * (QR / passkey UI) without iframing web.whatsapp.com.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  destroyWWeb,
  getWWebLastError,
  getWWebPupPage,
  getWWebStatus,
  initWWebClient,
  wipeWWebAuthData,
} from './whatsapp-web-client';

type PupPage = {
  target: () => { createCDPSession: () => Promise<CdpSession> };
  mouse: {
    click: (x: number, y: number, opts?: { button?: string }) => Promise<void>;
  };
  keyboard: {
    type: (text: string, opts?: { delay?: number }) => Promise<void>;
    press: (key: string) => Promise<void>;
  };
  viewport: () => { width: number; height: number } | null;
};

type CdpSession = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, handler: (params: { data: string; sessionId: string }) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
};

let latestFrameJpegBase64: string | null = null;
let cdp: CdpSession | null = null;
let pageRef: PupPage | null = null;
let screencastRunning = false;
let browserLoginActive = false;
const sockets = new Set<WebSocket>();

const wss = new WebSocketServer({ noServer: true });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function broadcast(payload: unknown): void {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(raw);
      } catch {
        /* ignore */
      }
    }
  }
}

async function stopScreencast(): Promise<void> {
  screencastRunning = false;
  if (cdp) {
    try {
      await cdp.send('Page.stopScreencast');
    } catch {
      /* ignore */
    }
  }
  cdp = null;
  pageRef = null;
}

async function startScreencast(page: PupPage): Promise<void> {
  await stopScreencast();
  pageRef = page;
  cdp = await page.target().createCDPSession();
  screencastRunning = true;

  cdp.on('Page.screencastFrame', (frame) => {
    latestFrameJpegBase64 = frame.data;
    broadcast({
      type: 'frame',
      mime: 'image/jpeg',
      data: frame.data,
      status: getWWebStatus(),
    });
    void cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 2,
  });
}

async function waitForPupPage(timeoutMs = 45000): Promise<PupPage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = getWWebPupPage() as PupPage | null;
    if (page) return page;
    const err = getWWebLastError();
    if (err && getWWebStatus() === 'error') return null;
    await sleep(400);
  }
  return null;
}

export function isBrowserLoginActive(): boolean {
  return browserLoginActive;
}

export function getBrowserLoginFrame(): string | null {
  return latestFrameJpegBase64;
}

export async function startBrowserLogin(opts?: {
  fresh?: boolean;
}): Promise<{ ok: boolean; error?: string; status: string }> {
  browserLoginActive = true;
  latestFrameJpegBase64 = null;
  await stopScreencast();
  await destroyWWeb();
  if (opts?.fresh) {
    await wipeWWebAuthData();
  }

  // Do not await full ready — page appears during QR wait.
  void initWWebClient({ browserLogin: true }).catch((err) => {
    console.error('Browser login init failed:', err);
  });

  const page = await waitForPupPage();
  if (!page) {
    const error =
      getWWebLastError() ||
      'WhatsApp browser page did not start. Check Chromium on the server (PUPPETEER_EXECUTABLE_PATH).';
    browserLoginActive = false;
    return { ok: false, error, status: getWWebStatus() };
  }

  try {
    await startScreencast(page);
  } catch (err) {
    const error = `Screencast failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, error, status: getWWebStatus() };
  }

  return { ok: true, status: getWWebStatus() };
}

export async function stopBrowserLogin(): Promise<{
  ok: boolean;
  status: string;
  message: string;
}> {
  await stopScreencast();
  browserLoginActive = false;
  latestFrameJpegBase64 = null;
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  sockets.clear();

  const status = getWWebStatus();
  if (status === 'ready') {
    return { ok: true, status, message: 'Login complete — WhatsApp ready' };
  }
  return {
    ok: true,
    status,
    message: 'Browser login stopped. Use Connect / Reconnect if still linking.',
  };
}

async function handleInput(msg: {
  type: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
}): Promise<void> {
  if (!pageRef) return;
  const vp = pageRef.viewport() || { width: 1280, height: 800 };
  if (msg.type === 'click' && typeof msg.x === 'number' && typeof msg.y === 'number') {
    const x = Math.max(0, Math.min(vp.width, msg.x));
    const y = Math.max(0, Math.min(vp.height, msg.y));
    await pageRef.mouse.click(x, y);
  } else if (msg.type === 'type' && msg.text) {
    await pageRef.keyboard.type(msg.text, { delay: 20 });
  } else if (msg.type === 'key' && msg.key) {
    await pageRef.keyboard.press(msg.key);
  }
}

function attachSocket(ws: WebSocket): void {
  sockets.add(ws);
  ws.send(
    JSON.stringify({
      type: 'hello',
      status: getWWebStatus(),
      active: browserLoginActive,
      hasFrame: Boolean(latestFrameJpegBase64),
    })
  );
  if (latestFrameJpegBase64) {
    ws.send(
      JSON.stringify({
        type: 'frame',
        mime: 'image/jpeg',
        data: latestFrameJpegBase64,
        status: getWWebStatus(),
      })
    );
  }

  ws.on('message', (raw: unknown) => {
    try {
      const msg = JSON.parse(String(raw)) as {
        type: string;
        x?: number;
        y?: number;
        text?: string;
        key?: string;
      };
      void handleInput(msg).catch((err) =>
        console.warn('Browser login input error:', err)
      );
    } catch {
      /* ignore bad payloads */
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
  });
}

export function handleBrowserLoginUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  if (url.pathname !== '/api/whatsapp-web/browser-login/stream') {
    return false;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    attachSocket(ws);
  });
  return true;
}
