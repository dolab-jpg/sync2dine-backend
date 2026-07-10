import type {
  AgentCallContext,
  CallEvent,
  TelephonyConfig,
  TelephonyProvider,
  TelephonyResponse,
} from './types';

export const mockAdapter: TelephonyProvider = {
  id: 'mock',

  parseInboundRequest(body: Record<string, unknown>): CallEvent | null {
    const type = String(body.type ?? 'speech_turn');
    const callId = String(body.callId ?? `mock-${Date.now()}`);
    return {
      type: type as CallEvent['type'],
      callId,
      providerCallId: callId,
      from: String(body.from ?? '447700900000'),
      to: String(body.to ?? '442012345678'),
      direction: (body.direction as CallEvent['direction']) ?? 'inbound',
      speechResult: body.speechResult ? String(body.speechResult) : undefined,
      confidence: body.confidence ? Number(body.confidence) : undefined,
      status: body.status as CallEvent['status'],
      raw: body,
    };
  },

  buildResponse(response: TelephonyResponse, callId: string): { contentType: string; body: string } {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        callId,
        speak: response.speak,
        gather: response.gather ?? true,
        transferTo: response.transferTo,
        hangup: response.hangup ?? false,
      }),
    };
  },

  verifyWebhook(): boolean {
    return true;
  },

  async placeCall(to: string, context: AgentCallContext, _config: TelephonyConfig) {
    const callId = `mock-out-${Date.now()}`;
    return { callId, providerCallId: callId };
  },

  async testConnection() {
    return { ok: true, message: 'Mock telephony provider ready — use Call Centre test panel' };
  },
};
