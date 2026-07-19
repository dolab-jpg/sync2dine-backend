/**
 * Merge Supabase integration rows with live server env / runtime probes
 * so the Integrations Hub can show Connected + details without re-pasting keys.
 */
import {
  listOrgIntegrations,
  type IntegrationStatus,
  type OrgIntegrationPublic,
} from './org-integrations-store';
import { ensureOrgOpenAIKeyLoaded, getOrgOpenAIKeyStatus } from './organizations';
import { getStripeRuntimeConfig } from './stripe-config';

export type IntegrationStatusSource = 'supabase' | 'env' | 'runtime' | 'both' | 'memory' | 'none';

export interface IntegrationStatusItem extends OrgIntegrationPublic {
  source: IntegrationStatusSource;
}

const SERVER_PLACEHOLDER = '(configured on server)';

function maskHint(value?: string | null): string {
  const v = value?.trim() ?? '';
  if (!v) return '';
  if (v.length <= 4) return '••••';
  return `••••${v.slice(-4)}`;
}

function baseItem(
  id: string,
  partial: Partial<IntegrationStatusItem> & { status: IntegrationStatus },
): IntegrationStatusItem {
  return {
    integrationId: id,
    enabled: partial.enabled ?? partial.status === 'connected',
    mockMode: partial.mockMode ?? false,
    status: partial.status,
    values: partial.values ?? {},
    configuredFields: partial.configuredFields ?? {},
    hasSecrets: partial.hasSecrets ?? Object.keys(partial.configuredFields ?? {}).length > 0,
    updatedAt: partial.updatedAt,
    source: partial.source ?? 'env',
  };
}

function mergeItems(primary: IntegrationStatusItem, secondary: IntegrationStatusItem): IntegrationStatusItem {
  const values = { ...secondary.values, ...primary.values };
  const configuredFields = { ...secondary.configuredFields, ...primary.configuredFields };
  const status: IntegrationStatus =
    primary.status === 'connected' || secondary.status === 'connected'
      ? 'connected'
      : primary.status === 'error' || secondary.status === 'error'
        ? 'error'
        : primary.status === 'mock' || secondary.status === 'mock'
          ? 'mock'
          : 'not_configured';
  const sources = new Set([primary.source, secondary.source]);
  let source: IntegrationStatusSource = primary.source;
  if (sources.has('supabase') && (sources.has('env') || sources.has('runtime'))) source = 'both';
  else if (sources.has('supabase')) source = 'supabase';
  else if (sources.has('runtime')) source = 'runtime';
  else if (sources.has('env')) source = 'env';

  return {
    integrationId: primary.integrationId,
    enabled: primary.enabled || secondary.enabled || status === 'connected',
    mockMode: status === 'connected' ? false : (primary.mockMode && secondary.mockMode),
    status,
    values,
    configuredFields,
    hasSecrets: Object.keys(configuredFields).length > 0,
    updatedAt: primary.updatedAt || secondary.updatedAt,
    source,
  };
}

function envVoiceProbes(): IntegrationStatusItem[] {
  const items: IntegrationStatusItem[] = [];

  const vapiKey = process.env.VAPI_PRIVATE_KEY?.trim() || process.env.VAPI_API_KEY?.trim();
  if (vapiKey) {
    items.push(baseItem('vapi', {
      status: 'connected',
      source: 'env',
      values: {
        region: process.env.VAPI_REGION || 'eu',
        webhookUrl: process.env.VAPI_WEBHOOK_BASE_URL || process.env.WEBHOOK_BASE_URL || '',
        publicKey: process.env.VAPI_PUBLIC_KEY ? SERVER_PLACEHOLDER : '',
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID ? SERVER_PLACEHOLDER : '',
      },
      configuredFields: {
        privateKey: maskHint(vapiKey) || SERVER_PLACEHOLDER,
        ...(process.env.VAPI_SERVER_SECRET ? { serverSecret: SERVER_PLACEHOLDER } : {}),
        ...(process.env.VAPI_PUBLIC_KEY ? { publicKey: maskHint(process.env.VAPI_PUBLIC_KEY) || SERVER_PLACEHOLDER } : {}),
        ...(process.env.VAPI_PHONE_NUMBER_ID ? { phoneNumberId: maskHint(process.env.VAPI_PHONE_NUMBER_ID) || SERVER_PLACEHOLDER } : {}),
      },
    }));
  }

  const elKey = process.env.ELEVENLABS_API_KEY?.trim();
  const elVoice = process.env.VAPI_ELEVENLABS_VOICE_ID?.trim() || process.env.ELEVENLABS_VOICE_ID?.trim();
  if (elKey || elVoice) {
    items.push(baseItem('elevenlabs', {
      status: 'connected',
      source: 'env',
      values: {
        voiceId: elVoice || '',
        modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5',
      },
      configuredFields: elKey
        ? { apiKey: maskHint(elKey) || SERVER_PLACEHOLDER }
        : {},
    }));
  }

  const sipUser = process.env.SOHO66_SIP_USERNAME?.trim();
  const sipDid = process.env.SOHO66_FROM_NUMBER?.trim();
  if (sipUser || sipDid) {
    items.push(baseItem('voice_telephony', {
      status: 'connected',
      source: 'env',
      values: {
        provider: 'soho66',
        sipUsername: sipUser || '',
        sipDomain: process.env.SOHO66_SIP_DOMAIN || 'sbc.soho66.co.uk',
        did: sipDid || '',
        sipBridgeUrl: process.env.SOHO66_SIP_BRIDGE_URL || '',
      },
      configuredFields: process.env.SOHO66_SIP_PASSWORD
        ? { sipPassword: SERVER_PLACEHOLDER }
        : {},
    }));
  }

  const stripeConfig = getStripeRuntimeConfig();
  if (stripeConfig.secretKey) {
    items.push(baseItem('stripe', {
      status: 'connected',
      source: process.env.STRIPE_SECRET_KEY?.trim() ? 'env' : 'runtime',
      values: {
        publishableKey: stripeConfig.publishableKey,
      },
      configuredFields: {
        secretKey: SERVER_PLACEHOLDER,
        ...(stripeConfig.webhookSecret ? { webhookSecret: SERVER_PLACEHOLDER } : {}),
      },
    }));
  }

  if (process.env.RESEND_API_KEY?.trim()) {
    items.push(baseItem('email_resend', {
      status: 'connected',
      source: 'env',
      values: {
        fromEmail: process.env.SMTP_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || '',
        fromName: process.env.SMTP_FROM_NAME || 'Sync2Dine',
      },
      configuredFields: { apiKey: SERVER_PLACEHOLDER },
    }));
  } else if (process.env.SENDGRID_API_KEY?.trim()) {
    items.push(baseItem('sendgrid', {
      status: 'connected',
      source: 'env',
      values: { fromEmail: process.env.SMTP_FROM_EMAIL || '' },
      configuredFields: { apiKey: SERVER_PLACEHOLDER },
    }));
  } else if (process.env.SMTP_HOST?.trim()) {
    items.push(baseItem('email_smtp', {
      status: 'connected',
      source: 'env',
      values: {
        host: process.env.SMTP_HOST || '',
        port: process.env.SMTP_PORT || '587',
        username: process.env.SMTP_USER || process.env.SMTP_USERNAME || '',
        fromEmail: process.env.SMTP_FROM_EMAIL || '',
        fromName: process.env.SMTP_FROM_NAME || '',
        secure: process.env.SMTP_SECURE === 'true' ? 'true' : 'false',
      },
      configuredFields: process.env.SMTP_PASSWORD
        ? { password: SERVER_PLACEHOLDER }
        : {},
    }));
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  if (supabaseUrl) {
    items.push(baseItem('supabase', {
      status: 'connected',
      source: 'env',
      values: { projectUrl: supabaseUrl },
      configuredFields: {
        ...(process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
          ? { anonKey: SERVER_PLACEHOLDER }
          : {}),
        ...(process.env.SUPABASE_SERVICE_ROLE_KEY ? { serviceRoleKey: SERVER_PLACEHOLDER } : {}),
      },
    }));
    items.push(baseItem('storage', {
      status: 'connected',
      source: 'env',
      values: {
        provider: 'supabase',
        bucket: process.env.SUPABASE_STORAGE_BUCKET || 'project-files',
      },
      configuredFields: {},
    }));
  }

  const appBase = process.env.APP_BASE_URL?.trim() || process.env.WEBHOOK_BASE_URL?.trim();
  if (appBase) {
    items.push(baseItem('webhook_server', {
      status: 'connected',
      source: 'env',
      values: {
        baseUrl: appBase.replace(/\/$/, ''),
        healthEndpoint: '/health',
      },
      configuredFields: {},
    }));
  }

  return items;
}

async function runtimeWhatsApp(): Promise<IntegrationStatusItem | null> {
  try {
    const { getWWebStatus, getWWebInfo } = await import('./whatsapp-web-client');
    const status = String(getWWebStatus() || '');
    if (!status || status === 'disconnected' || status === 'unauthenticated') return null;
    const info = (getWWebInfo() || {}) as { pushname?: string; phone?: string; wid?: string };
    // Only "ready" is truly connected — qr_pending / authenticated alone must not green-badge the hub.
    const connected = status === 'ready';
    return baseItem('whatsapp', {
      status: connected ? 'connected' : 'error',
      source: 'runtime',
      values: {
        cyrusDisplayName: 'Cynthia',
        whatsappStatus: status,
        ...(info.pushname ? { pushname: String(info.pushname) } : {}),
        ...(info.phone ? { phone: String(info.phone) } : {}),
        ...(info.wid ? { wid: String(info.wid) } : {}),
      },
      configuredFields: {},
      hasSecrets: false,
    });
  } catch {
    return null;
  }
}

async function brainOverlay(orgId: string): Promise<IntegrationStatusItem | null> {
  try {
    await ensureOrgOpenAIKeyLoaded(orgId);
    const brain = getOrgOpenAIKeyStatus(orgId);
    if (!brain.configured && !brain.deepseekConfigured) return null;
    const configuredFields: Record<string, string> = {};
    if (brain.configured && brain.maskedHint) configuredFields.apiKey = brain.maskedHint;
    if (brain.deepseekConfigured && brain.deepseekMaskedHint) {
      configuredFields.deepseekApiKey = brain.deepseekMaskedHint;
    }
    return baseItem('openai', {
      status: 'connected',
      source: 'env',
      values: {
        provider: brain.provider === 'deepseek' ? 'deepseek' : 'openai',
      },
      configuredFields,
    });
  } catch {
    return null;
  }
}

export async function buildOrgIntegrationsStatus(orgId: string): Promise<{
  orgId: string;
  integrations: IntegrationStatusItem[];
  summary: {
    connected: number;
    notConfigured: number;
    error: number;
    mock: number;
    total: number;
    registryHint: number;
  };
}> {
  const byId = new Map<string, IntegrationStatusItem>();

  const fromSb = await listOrgIntegrations(orgId);
  for (const row of fromSb) {
    byId.set(row.integrationId, {
      ...row,
      source: (row.source as IntegrationStatusSource) || 'supabase',
    });
  }

  for (const envItem of envVoiceProbes()) {
    const existing = byId.get(envItem.integrationId);
    byId.set(
      envItem.integrationId,
      existing ? mergeItems(existing, envItem) : envItem,
    );
  }

  const brain = await brainOverlay(orgId);
  if (brain) {
    const existing = byId.get('openai');
    byId.set('openai', existing ? mergeItems(existing, brain) : brain);
  }

  const wa = await runtimeWhatsApp();
  if (wa) {
    const existing = byId.get('whatsapp');
    byId.set('whatsapp', existing ? mergeItems(existing, wa) : wa);
  }

  const integrations = [...byId.values()].sort((a, b) =>
    a.integrationId.localeCompare(b.integrationId),
  );

  const summary = {
    connected: integrations.filter((i) => i.status === 'connected').length,
    notConfigured: integrations.filter((i) => i.status === 'not_configured').length,
    error: integrations.filter((i) => i.status === 'error').length,
    mock: integrations.filter((i) => i.status === 'mock').length,
    total: integrations.length,
    registryHint: 20,
  };

  return { orgId, integrations, summary };
}
