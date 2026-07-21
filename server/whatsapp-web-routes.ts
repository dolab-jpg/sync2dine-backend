/**
 * Admin API routes for WhatsApp Web.js client management.
 * QR code display, connection status, logout, browser login, and read receipts.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  getWWebStatus,
  getWWebQR,
  getWWebInfo,
  getWWebLastError,
  getWWebDebug,
  getReadReceipts,
  logoutWWeb,
  reconnectWWeb,
} from './whatsapp-web-client';
import {
  getBrowserLoginFrame,
  isBrowserLoginActive,
  startBrowserLogin,
  stopBrowserLogin,
} from './whatsapp-web-browser-login';
import QRCode from 'qrcode';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function handleWWebRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url?: URL
): Promise<boolean> {
  if (pathname === '/api/whatsapp-web/status' && req.method === 'GET') {
    const error = getWWebLastError();
    const debug = getWWebDebug();
    sendJson(res, 200, {
      status: getWWebStatus(),
      info: getWWebInfo(),
      browserLoginActive: isBrowserLoginActive(),
      canSend: Boolean(debug.canSend),
      debug,
      ...(error ? { error } : {}),
    });
    return true;
  }

  if (pathname === '/api/whatsapp-web/qr' && req.method === 'GET') {
    const qr = getWWebQR();
    const status = getWWebStatus();
    const error = getWWebLastError();
    let qrImageDataUrl: string | null = null;
    if (qr) {
      try {
        qrImageDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
      } catch {
        /* fallback to raw qr string */
      }
    }
    sendJson(res, 200, {
      qr,
      qrImageDataUrl,
      status,
      browserLoginActive: isBrowserLoginActive(),
      ...(error ? { error } : {}),
    });
    return true;
  }

  if (pathname === '/api/whatsapp-web/logout' && req.method === 'POST') {
    await stopBrowserLogin();
    await logoutWWeb();
    sendJson(res, 200, { success: true, message: 'Logged out' });
    return true;
  }

  if (pathname === '/api/whatsapp-web/reconnect' && req.method === 'POST') {
    const fresh =
      url?.searchParams.get('fresh') === '1' ||
      url?.searchParams.get('fresh') === 'true';
    await stopBrowserLogin();
    await reconnectWWeb({ fresh });
    sendJson(res, 200, {
      success: true,
      message: fresh
        ? 'Fresh reconnect — scan a new QR when it appears'
        : 'Reconnecting — check /api/whatsapp-web/qr for new QR code',
    });
    return true;
  }

  if (pathname === '/api/whatsapp-web/browser-login/start' && req.method === 'POST') {
    let fresh = false;
    try {
      const raw = await readBody(req);
      if (raw) {
        const parsed = JSON.parse(raw) as { fresh?: boolean };
        fresh = Boolean(parsed.fresh);
      }
    } catch {
      /* empty body ok */
    }
    if (url?.searchParams.get('fresh') === '1') fresh = true;
    const result = await startBrowserLogin({ fresh });
    sendJson(res, result.ok ? 200 : 500, result);
    return true;
  }

  if (pathname === '/api/whatsapp-web/browser-login/stop' && req.method === 'POST') {
    const result = await stopBrowserLogin();
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/whatsapp-web/browser-login/frame' && req.method === 'GET') {
    const frame = getBrowserLoginFrame();
    sendJson(res, 200, {
      active: isBrowserLoginActive(),
      status: getWWebStatus(),
      frame: frame ? `data:image/jpeg;base64,${frame}` : null,
      error: getWWebLastError() || undefined,
    });
    return true;
  }

  if (pathname.startsWith('/api/whatsapp-web/read-receipts') && req.method === 'GET') {
    const parts = pathname.split('/');
    const chatId =
      parts[4] && parts[4] !== 'read-receipts' ? decodeURIComponent(parts[4]) : undefined;
    sendJson(res, 200, { receipts: getReadReceipts(chatId) });
    return true;
  }

  if (pathname === '/api/whatsapp-web/send' && req.method === 'POST') {
    const body = await readBody(req);
    const { to, message, media } = JSON.parse(body);
    if (!to || !message) {
      sendJson(res, 400, { error: 'Missing "to" or "message"' });
      return true;
    }

    const { sendWWebMessage } = await import('./whatsapp-web-client');
    const messageId = await sendWWebMessage(to, message, media ? { media } : undefined);
    if (messageId) {
      sendJson(res, 200, { success: true, messageId });
    } else {
      sendJson(res, 500, {
        success: false,
        error: 'Failed to send — client may not be ready',
      });
    }
    return true;
  }

  return false;
}
