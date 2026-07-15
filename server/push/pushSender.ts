import type { DeviceTokenRecord } from './deviceTokenStore';

export interface PushPayload {
  title: string;
  body: string;
  route?: string;
  data?: Record<string, string>;
}

export interface PushSendResult {
  sent: number;
  dryRun: boolean;
  errors: string[];
}

/**
 * Sends FCM push notifications. When FIREBASE_SERVER_KEY is unset, runs in dry-run mode
 * (logs payload, returns success for testing).
 */
export async function sendPushToTokens(
  tokens: DeviceTokenRecord[],
  payload: PushPayload,
): Promise<PushSendResult> {
  const serverKey = process.env.FIREBASE_SERVER_KEY?.trim();
  const dryRun = !serverKey;
  const errors: string[] = [];
  let sent = 0;

  const data: Record<string, string> = {
    ...(payload.data ?? {}),
    ...(payload.route ? { route: payload.route } : {}),
  };

  for (const record of tokens) {
    if (dryRun) {
      console.info('[push dry-run]', record.platform, payload.title, payload.body, data);
      sent += 1;
      continue;
    }

    try {
      const res = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          Authorization: `key=${serverKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: record.token,
          notification: {
            title: payload.title,
            body: payload.body,
          },
          data,
        }),
      });

      if (!res.ok) {
        errors.push(`FCM ${res.status} for ${record.token.slice(0, 8)}…`);
        continue;
      }
      sent += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'FCM send failed');
    }
  }

  return { sent, dryRun, errors };
}

export async function sendPushToOrg(
  orgId: string,
  payload: PushPayload,
  listTokens: (orgId: string) => DeviceTokenRecord[],
): Promise<PushSendResult> {
  const tokens = listTokens(orgId);
  if (tokens.length === 0) {
    return { sent: 0, dryRun: !process.env.FIREBASE_SERVER_KEY, errors: [] };
  }
  return sendPushToTokens(tokens, payload);
}

/** User-targeted Cynthia notifications — never broadcasts to the whole org. */
export async function sendPushToUser(
  orgId: string,
  userId: string,
  payload: PushPayload,
): Promise<PushSendResult> {
  const { listDeviceTokens } = await import('./deviceTokenStore');
  const tokens = listDeviceTokens({ orgId, userId });
  if (tokens.length === 0) {
    return { sent: 0, dryRun: !process.env.FIREBASE_SERVER_KEY?.trim(), errors: [] };
  }
  return sendPushToTokens(tokens, payload);
}
