/** Debug-session NDJSON logger (session d0f60a). Safe no-op on failure. */
import { appendFileSync } from 'fs';

const INGEST = 'http://127.0.0.1:7610/ingest/e809fe57-584f-4b4e-8cfb-f3dee6b9facf';
const FILE = process.env.DEBUG_D0F60A_LOG || '/tmp/debug-d0f60a.log';

export function debugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown> = {},
  runId = 'verify1',
): void {
  const payload = {
    sessionId: 'd0f60a',
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
    runId,
  };
  try {
    appendFileSync(FILE, `${JSON.stringify(payload)}\n`);
  } catch {
    /* ignore */
  }
  try {
    void fetch(INGEST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': 'd0f60a',
      },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
