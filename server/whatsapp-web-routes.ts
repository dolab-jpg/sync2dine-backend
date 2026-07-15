/**
 * Admin API routes for WhatsApp Web.js client management.
 * QR code display, connection status, logout, and read receipts.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  getWWebStatus,
  getWWebQR,
  getWWebInfo,
  getReadReceipts,
  logoutWWeb,
  initWWebClient,
} from './whatsapp-web-client';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function handleWWebRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname === '/api/whatsapp-web/status' && req.method === 'GET') {
    sendJson(res, 200, {
      status: getWWebStatus(),
      info: getWWebInfo(),
    });
    return true;
  }

  if (pathname === '/api/whatsapp-web/qr' && req.method === 'GET') {
    const qr = getWWebQR();
    const status = getWWebStatus();
    sendJson(res, 200, { qr, status });
    return true;
  }

  if (pathname === '/api/whatsapp-web/logout' && req.method === 'POST') {
    await logoutWWeb();
    sendJson(res, 200, { success: true, message: 'Logged out' });
    return true;
  }

  if (pathname === '/api/whatsapp-web/reconnect' && req.method === 'POST') {
    await logoutWWeb();
    void initWWebClient();
    sendJson(res, 200, { success: true, message: 'Reconnecting — check /api/whatsapp-web/qr for new QR code' });
    return true;
  }

  if (pathname.startsWith('/api/whatsapp-web/read-receipts') && req.method === 'GET') {
    const parts = pathname.split('/');
    const chatId = parts[4] && parts[4] !== 'read-receipts' ? decodeURIComponent(parts[4]) : undefined;
    sendJson(res, 200, { receipts: getReadReceipts(chatId) });
    return true;
  }

  if (pathname === '/api/whatsapp-web/send' && req.method === 'POST') {
    const body = await new Promise<string>((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
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
      sendJson(res, 500, { success: false, error: 'Failed to send — client may not be ready' });
    }
    return true;
  }

  return false;
}
