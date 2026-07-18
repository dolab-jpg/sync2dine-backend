import type { ServerResponse } from 'http';

/**
 * HTML page returned from OAuth callbacks when the flow was started in a popup.
 * Posts a message to window.opener then closes.
 */
export function sendOAuthPopupResult(
  res: ServerResponse,
  messageType: string,
  payload: { ok: boolean; email?: string; provider?: string; error?: string },
  targetOrigin = '*',
): void {
  const body = JSON.stringify({
    type: messageType,
    ok: payload.ok,
    email: payload.email ?? null,
    provider: payload.provider ?? null,
    error: payload.error ?? null,
  });
  const originJson = JSON.stringify(targetOrigin || '*');
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connecting…</title></head>
<body>
<p style="font-family:system-ui,sans-serif;padding:1.5rem">You can close this window.</p>
<script>
(function () {
  var msg = ${body};
  var target = ${originJson};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, target);
    }
  } catch (e) {}
  try { window.close(); } catch (e) {}
  setTimeout(function () {
    document.body.innerHTML = '<p style="font-family:system-ui,sans-serif;padding:1.5rem">' +
      (msg.ok ? 'Connected — you can close this window.' : ('Error: ' + (msg.error || 'OAuth failed'))) +
      '</p>';
  }, 200);
})();
</script>
</body></html>`;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}
