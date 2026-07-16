import { buildAgentTtsUrl, shouldUsePlayAudio } from '../tts';
import { resolveAvailableLineForOutbound } from '../data-store';
import { getWebhookBaseUrl } from './lineRegistry';
import type {
  AgentCallContext,
  CallEvent,
  TelephonyConfig,
  TelephonyProvider,
  TelephonyResponse,
} from './types';

const GATHER_PROMPT = 'Please go ahead when you are ready.';

export const soho66Adapter: TelephonyProvider = {
  id: 'soho66',

  parseInboundRequest(body: Record<string, unknown>): CallEvent | null {
    const type = String(body.type ?? 'speech_turn');
    const callId = String(body.callId ?? `soho66-${Date.now()}`);
    return {
      type: type as CallEvent['type'],
      callId,
      providerCallId: String(body.providerCallId ?? body.CallSid ?? callId),
      from: String(body.from ?? body.From ?? '447700900000'),
      to: String(body.to ?? body.To ?? '442012345678'),
      direction: (body.direction as CallEvent['direction']) ?? 'inbound',
      speechResult: body.speechResult
        ? String(body.speechResult)
        : body.SpeechResult
          ? String(body.SpeechResult)
          : undefined,
      confidence: body.confidence ? Number(body.confidence) : undefined,
      status: body.status as CallEvent['status'],
      raw: body,
    };
  },

  buildResponse(response: TelephonyResponse, callId: string, config: TelephonyConfig) {
    const webhookBase = config.webhookBaseUrl ?? process.env.WEBHOOK_BASE_URL ?? process.env.APP_BASE_URL ?? '';
    const usePlay = shouldUsePlayAudio() && !!webhookBase;
    const turnUrl = `${webhookBase.replace(/\/$/, '')}/webhooks/voice/turn?callId=${encodeURIComponent(callId)}`;

    return {
      contentType: 'application/json',
      body: JSON.stringify({
        callId,
        speak: response.speak,
        gather: response.gather ?? true,
        transferTo: response.transferTo,
        hangup: response.hangup ?? false,
        playUrl: usePlay && response.speak
          ? buildAgentTtsUrl(webhookBase, { callId, format: 'mulaw' })
          : undefined,
        gatherPlayUrl: undefined,
        gatherActionUrl: turnUrl,
        provider: 'soho66',
        bridgeNote: 'Route Soho66 SIP through the sip-bridge and POST call events to /webhooks/voice/*',
      }),
    };
  },

  verifyWebhook(): boolean {
    return true;
  },

  async placeCall(to: string, context: AgentCallContext, config: TelephonyConfig) {
    const bridgeUrl = config.sipBridgeUrl ?? process.env.SOHO66_SIP_BRIDGE_URL;
    if (!bridgeUrl) {
      throw new Error(
        'Soho66 outbound requires SOHO66_SIP_BRIDGE_URL (Jambonz/FreeSWITCH bridge) — configure in Integrations → Voice Telephony',
      );
    }

    const line = resolveAvailableLineForOutbound();
    const from = line?.did ?? config.fromNumber ?? process.env.SOHO66_FROM_NUMBER ?? '';

    const callId = context.callId ?? `soho66-out-${Date.now()}`;
    const template = context.campaignTemplate ?? 'lead_callback';
    const webhookBase = (config.webhookBaseUrl ?? getWebhookBaseUrl()).replace(/\/$/, '');
    const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        from,
        callId,
        lineId: line?.id,
        webhookUrl: `${webhookBase}/webhooks/voice/outbound?callId=${encodeURIComponent(callId)}&template=${encodeURIComponent(template)}`,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Soho66 bridge dial failed: ${err || response.status}`);
    }

    const result = await response.json().catch(() => ({})) as { sid?: string; callId?: string };
    return { callId, providerCallId: result.sid ?? result.callId ?? callId };
  },

  async testConnection(config: TelephonyConfig) {
    const { listPhoneLines } = await import('../data-store');
    const lines = listPhoneLines();
    const bridgeUrl = config.sipBridgeUrl ?? process.env.SOHO66_SIP_BRIDGE_URL;

    if (lines.length === 0) {
      return {
        ok: false,
        message: 'No phone lines configured — add lines in Call Centre → Phone Lines',
      };
    }

    const registered = lines.filter(l => l.status === 'registered').length;
    const bridgeNote = bridgeUrl
      ? `SIP bridge configured (${bridgeUrl}). ${registered}/${lines.length} lines registered.`
      : 'Set SOHO66_SIP_BRIDGE_URL and use Register all lines in Call Centre.';

    return {
      ok: true,
      message: `${lines.length} Soho66 line(s) configured. ${bridgeNote}`,
    };
  },
};
