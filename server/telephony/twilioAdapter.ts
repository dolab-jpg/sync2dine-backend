import { createHmac } from 'crypto';
import { buildAgentTtsUrl, shouldUsePlayAudio } from '../tts';
import type {
  AgentCallContext,
  CallEvent,
  TelephonyConfig,
  TelephonyProvider,
  TelephonyResponse,
} from './types';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildTwiml(response: TelephonyResponse, webhookBase: string, callId: string): string {
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];
  const usePlay = shouldUsePlayAudio() && !!webhookBase;

  if (response.speak) {
    if (usePlay) {
      const playUrl = buildAgentTtsUrl(webhookBase, { callId });
      parts.push(`<Play>${escapeXml(playUrl)}</Play>`);
    } else {
      parts.push(`<Say voice="Polly.Amy" language="en-GB">${escapeXml(response.speak)}</Say>`);
    }
  }

  if (response.transferTo) {
    parts.push(`<Dial>${escapeXml(response.transferTo)}</Dial>`);
  } else if (response.hangup) {
    parts.push('<Hangup/>');
  } else if (response.gather !== false) {
    const action = `${webhookBase.replace(/\/$/, '')}/webhooks/voice/turn?callId=${encodeURIComponent(callId)}`;
    const gatherPrompt = 'Please go ahead when you are ready.';
    const gatherAudio = usePlay
      ? `<Play>${escapeXml(buildAgentTtsUrl(webhookBase, { text: gatherPrompt }))}</Play>`
      : `<Say voice="Polly.Amy" language="en-GB">${escapeXml(gatherPrompt)}</Say>`;
    parts.push(
      `<Gather input="speech" language="en-GB" speechTimeout="auto" action="${escapeXml(action)}" method="POST">`,
      gatherAudio,
      '</Gather>',
    );
  }

  parts.push('</Response>');
  return parts.join('');
}

function mapTwilioStatus(status: string): CallEvent['status'] {
  const map: Record<string, CallEvent['status']> = {
    ringing: 'ringing',
    'in-progress': 'in_progress',
    completed: 'completed',
    failed: 'failed',
    'no-answer': 'no_answer',
    busy: 'busy',
  };
  return map[status] ?? 'in_progress';
}

export const twilioAdapter: TelephonyProvider = {
  id: 'twilio',

  parseInboundRequest(body: Record<string, unknown>, _headers: Record<string, string>): CallEvent | null {
    const callSid = String(body.CallSid ?? body.callSid ?? '');
    const callId = String(body.callId ?? callSid ?? `tw-${Date.now()}`);

    if (body.CallStatus && !body.SpeechResult && !body.Digits) {
      return {
        type: 'status_update',
        callId,
        providerCallId: callSid,
        from: String(body.From ?? body.from ?? ''),
        to: String(body.To ?? body.to ?? ''),
        direction: String(body.Direction ?? '').startsWith('outbound') ? 'outbound' : 'inbound',
        status: mapTwilioStatus(String(body.CallStatus)),
        recordingUrl: body.RecordingUrl ? String(body.RecordingUrl) : undefined,
        raw: body,
      };
    }

    const speechResult = body.SpeechResult ? String(body.SpeechResult) : undefined;
    const isStart = !speechResult && body.CallStatus === 'ringing';

    return {
      type: isStart ? 'call_started' : speechResult ? 'speech_turn' : 'status_update',
      callId,
      providerCallId: callSid,
      from: String(body.From ?? body.from ?? ''),
      to: String(body.To ?? body.to ?? ''),
      direction: String(body.Direction ?? '').startsWith('outbound') ? 'outbound' : 'inbound',
      speechResult,
      confidence: body.Confidence ? Number(body.Confidence) : undefined,
      status: body.CallStatus ? mapTwilioStatus(String(body.CallStatus)) : undefined,
      raw: body,
    };
  },

  buildResponse(response: TelephonyResponse, callId: string, config: TelephonyConfig) {
    const base = config.webhookBaseUrl ?? process.env.WEBHOOK_BASE_URL ?? '';
    return {
      contentType: 'text/xml',
      body: buildTwiml(response, base, callId),
    };
  },

  verifyWebhook(body: string, url: string, headers: Record<string, string>, config: TelephonyConfig): boolean {
    const authToken = config.authToken ?? process.env.TWILIO_AUTH_TOKEN ?? '';
    if (!authToken) return process.env.NODE_ENV !== 'production';

    const signature = headers['x-twilio-signature'] ?? headers['X-Twilio-Signature'];
    if (!signature) return false;

    const params = new URLSearchParams(body);
    const sortedKeys = [...params.keys()].sort();
    let data = url;
    for (const key of sortedKeys) {
      data += key + params.get(key);
    }

    const expected = createHmac('sha1', authToken).update(data).digest('base64');
    return expected === signature;
  },

  async placeCall(to: string, context: AgentCallContext, config: TelephonyConfig) {
    const accountSid = config.accountSid ?? process.env.TWILIO_ACCOUNT_SID ?? '';
    const authToken = config.authToken ?? process.env.TWILIO_AUTH_TOKEN ?? '';
    const from = config.fromNumber ?? process.env.TWILIO_FROM_NUMBER ?? '';
    const webhookBase = config.webhookBaseUrl ?? process.env.WEBHOOK_BASE_URL ?? '';

    if (!accountSid || !authToken || !from) {
      throw new Error('Twilio credentials not configured');
    }

    const callId = context.callId ?? `out-${Date.now()}`;
    const twimlUrl = `${webhookBase.replace(/\/$/, '')}/webhooks/voice/outbound?callId=${encodeURIComponent(callId)}&template=${encodeURIComponent(String(context.campaignTemplate ?? 'lead_callback'))}`;

    const params = new URLSearchParams({
      To: to,
      From: from,
      Url: twimlUrl,
      Method: 'POST',
      StatusCallback: `${webhookBase.replace(/\/$/, '')}/webhooks/voice/status`,
      StatusCallbackMethod: 'POST',
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Twilio outbound failed: ${err}`);
    }

    const result = await response.json() as { sid?: string };
    return { callId, providerCallId: result.sid };
  },

  async testConnection(config: TelephonyConfig) {
    const accountSid = config.accountSid ?? process.env.TWILIO_ACCOUNT_SID ?? '';
    const authToken = config.authToken ?? process.env.TWILIO_AUTH_TOKEN ?? '';
    if (!accountSid || !authToken) {
      return { ok: false, message: 'Account SID and Auth Token required' };
    }

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        },
      },
    );

    if (!response.ok) {
      return { ok: false, message: `Twilio API error (${response.status})` };
    }

    return { ok: true, message: 'Twilio Voice connection successful' };
  },
};

/** Standalone SMS helper (G27) — not part of TelephonyProvider interface. */
export async function sendTwilioSms(to: string, body: string): Promise<{ sid?: string; stub?: boolean }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? '';
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? '';
  const from = process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER ?? '';
  if (!accountSid || !authToken || !from) {
    return { stub: true };
  }
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    },
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Twilio SMS failed: ${err}`);
  }
  const result = await response.json() as { sid?: string };
  return { sid: result.sid };
}
