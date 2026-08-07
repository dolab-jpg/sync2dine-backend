/**
 * Vapi telephony adapter — managed SIP/media outbound calls.
 */
import { saveCall } from '../data-store';
import {
  getVapiPrivateKey,
  getVapiWebhookBaseUrl,
  toE164Uk,
  vapiFetch,
} from '../vapi-client';
import type {
  AgentCallContext,
  CallEvent,
  TelephonyConfig,
  TelephonyProvider,
  TelephonyResponse,
} from './types';

const META_STRING_KEYS = [
  'agentPersona',
  'aim',
  'brief',
  'source',
  'company',
  'batchId',
  'customerId',
  'customerName',
  'projectId',
  'referredByName',
  'referredByPhone',
  'referredByVenue',
  'sourceCallId',
] as const;

/** Flatten outbound context + nested metadata for call row + Vapi metadata. */
export function outboundMetaFromContext(context: AgentCallContext): Record<string, unknown> {
  const nested = (context.metadata && typeof context.metadata === 'object')
    ? (context.metadata as Record<string, unknown>)
    : {};
  const out: Record<string, unknown> = { ...nested };
  for (const key of META_STRING_KEYS) {
    const fromNested = nested[key];
    const fromTop = (context as unknown as Record<string, unknown>)[key];
    const raw = fromNested != null && String(fromNested).trim()
      ? fromNested
      : fromTop;
    if (raw != null && String(raw).trim()) out[key] = String(raw).trim();
  }
  if (context.customerId && !out.customerId) out.customerId = String(context.customerId);
  if (context.customerName && !out.customerName) out.customerName = String(context.customerName);
  if (context.projectId && !out.projectId) out.projectId = String(context.projectId);
  if (context.campaignTemplate && !out.campaignTemplate) {
    out.campaignTemplate = String(context.campaignTemplate);
  }
  return out;
}

function metadataFromContext(context: AgentCallContext): Record<string, string> {
  const meta: Record<string, string> = {
    tradeproCallId: context.callId,
    direction: context.direction,
  };
  const enriched = outboundMetaFromContext(context);
  for (const [key, value] of Object.entries(enriched)) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s) meta[key] = s;
  }
  return meta;
}

export const vapiAdapter: TelephonyProvider = {
  id: 'vapi',

  parseInboundRequest(body: Record<string, unknown>): CallEvent | null {
    const message = (body.message || body) as Record<string, unknown>;
    const call = (message.call || body.call || body) as Record<string, unknown>;
    const callId = String(call.id || body.callId || `vapi-${Date.now()}`);
    const customer = call.customer as Record<string, unknown> | undefined;
    const customerNumber = String(customer?.number || body.to || '').trim();
    return {
      type: 'call_started',
      callId,
      providerCallId: callId,
      from: String(call.phoneNumber || process.env.SOHO66_FROM_NUMBER || ''),
      to: customerNumber,
      direction: String(call.type || '').toLowerCase().includes('outbound') ? 'outbound' : 'inbound',
      status: 'in_progress',
      raw: body,
    };
  },

  buildResponse(response: TelephonyResponse, callId: string) {
    // Vapi owns media; local TwiML-style responses are unused.
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        callId,
        speak: response.speak,
        gather: response.gather ?? true,
        hangup: response.hangup ?? false,
        provider: 'vapi',
      }),
    };
  },

  verifyWebhook(_body: string, _url: string, headers: Record<string, string>, _config: TelephonyConfig): boolean {
    const secret = process.env.VAPI_SERVER_SECRET?.trim();
    if (!secret) return true;
    const header = headers['x-vapi-secret'] || headers.authorization || '';
    return header.includes(secret);
  },

  async placeCall(to: string, context: AgentCallContext, config: TelephonyConfig) {
    if (!getVapiPrivateKey()) {
      throw new Error('VAPI_PRIVATE_KEY is required for VOICE_PROVIDER=vapi');
    }

    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID?.trim();
    if (!phoneNumberId) {
      throw new Error(
        'VAPI_PHONE_NUMBER_ID is required — run npm run vapi:setup after adding VAPI_PRIVATE_KEY',
      );
    }

    const callId = context.callId ?? `vapi-out-${Date.now()}`;
    const customerNumber = toE164Uk(to);
    const webhookBase = getVapiWebhookBaseUrl();
    const fromNumber = toE164Uk(
      config.fromNumber || process.env.SOHO66_FROM_NUMBER || process.env.VAPI_FROM_NUMBER || '',
    );
    const outboundMeta = outboundMetaFromContext(context);
    const agentPersona = outboundMeta.agentPersona != null
      ? String(outboundMeta.agentPersona)
      : undefined;

    // Seed call row BEFORE assistant build so callMeta (aim/source/persona) reaches Sally brain.
    saveCall({
      id: callId,
      provider: 'vapi',
      direction: 'outbound',
      from: fromNumber || process.env.SOHO66_FROM_NUMBER || '',
      to: customerNumber,
      status: 'ringing',
      transcript: [],
      startedAt: new Date().toISOString(),
      customerId: context.customerId || (outboundMeta.customerId != null ? String(outboundMeta.customerId) : undefined),
      contactName: context.customerName,
      campaignTemplate: context.campaignTemplate,
      metadata: {
        ...outboundMeta,
        tradeproCallId: callId,
        partyPhone: customerNumber,
        webhookBase,
      },
    });

    const { buildVapiAssistantForParty } = await import('../vapi-assistant');
    const { assistant, identity, agentPersona: resolvedPersona } = await buildVapiAssistantForParty({
      partyPhone: customerNumber,
      direction: 'outbound',
      campaignTemplate: context.campaignTemplate,
      callId,
      contactName: context.customerName,
      agentPersona,
    });

    const seededMeta: Record<string, unknown> = {
      ...outboundMeta,
      tradeproCallId: callId,
      partyPhone: customerNumber,
      webhookBase,
      callerKind: identity.kind,
      callerRole: identity.role,
      phoneAuth: identity.needsPin ? 'pending' : 'n/a',
      ...(resolvedPersona ? { agentPersona: resolvedPersona } : {}),
    };

    saveCall({
      id: callId,
      contactName: identity.kind !== 'customer' ? identity.name : context.customerName,
      metadata: seededMeta,
    });

    const payload: Record<string, unknown> = {
      phoneNumberId,
      customer: {
        number: customerNumber,
        numberE164CheckEnabled: true,
        name: context.customerName || undefined,
      },
      assistant,
      metadata: metadataFromContext({ ...context, callId, metadata: seededMeta }),
    };

    const result = await vapiFetch('/call/phone', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!result.ok) {
      saveCall({
        id: callId,
        status: 'failed',
        endedAt: new Date().toISOString(),
        outcome: 'vapi_dial_failed',
        metadata: {
          ...seededMeta,
          dialError: result.raw.slice(0, 400),
        },
      });
      throw new Error(`Vapi dial failed (${result.status}): ${result.raw.slice(0, 400)}`);
    }

    const providerCallId = String(result.json.id || result.json.callId || callId);
    saveCall({
      id: callId,
      providerCallId,
      provider: 'vapi',
      status: 'in_progress',
      metadata: {
        ...seededMeta,
        vapiCallId: providerCallId,
      },
    });

    return { callId, providerCallId };
  },

  async testConnection(_config: TelephonyConfig) {
    if (!getVapiPrivateKey()) {
      return { ok: false, message: 'VAPI_PRIVATE_KEY missing' };
    }
    try {
      const result = await vapiFetch('/phone-number', { method: 'GET' });
      if (!result.ok) {
        return { ok: false, message: `Vapi API error ${result.status}: ${result.raw.slice(0, 200)}` };
      }
      const phoneId = process.env.VAPI_PHONE_NUMBER_ID?.trim();
      return {
        ok: true,
        message: phoneId
          ? `Vapi connected. Phone number id=${phoneId}`
          : 'Vapi connected, but VAPI_PHONE_NUMBER_ID is not set — run npm run vapi:setup',
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
