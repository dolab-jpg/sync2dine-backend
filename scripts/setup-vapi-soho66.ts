/**
 * Provision Vapi BYO SIP trunk + phone number for Soho66 Aria line.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/setup-vapi-soho66.ts
 *
 * Requires:
 *   VAPI_PRIVATE_KEY
 *   Optional: VAPI_REGION=eu, VAPI_WEBHOOK_BASE_URL (public HTTPS), ELEVENLABS_API_KEY, VAPI_ELEVENLABS_VOICE_ID
 *
 * Writes IDs back into .env (appends) and .cursor/local/deploy.env
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadSyncedLine() {
  const dataPath = join(root, 'server', 'data', 'synced-data.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as {
    phoneLines?: Array<Record<string, unknown>>;
  };
  const lines = data.phoneLines || [];
  const aria = lines.find((l) => l.purpose === 'aria') || lines[0];
  if (!aria) throw new Error('No phone lines in synced-data.json');
  return aria;
}

function toE164Uk(input: string): string {
  const raw = String(input || '').trim();
  if (raw.startsWith('+')) return raw.replace(/\s+/g, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('44')) return `+${digits}`;
  if (digits.startsWith('0')) return `+44${digits.slice(1)}`;
  return `+${digits}`;
}

function upsertEnv(filePath: string, updates: Record<string, string>) {
  let content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) content = content.replace(re, line);
    else content = `${content.trimEnd()}\n${line}\n`;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

async function main() {
  const key = process.env.VAPI_PRIVATE_KEY?.trim() || process.env.VAPI_API_KEY?.trim();
  if (!key) {
    console.error('Missing VAPI_PRIVATE_KEY. Create one at https://dashboard.vapi.ai (use EU org if UK).');
    console.error('Then add to tradepro-backend/.env and re-run: npm run vapi:setup');
    process.exit(1);
  }

  const region = String(process.env.VAPI_REGION || 'eu').toLowerCase() === 'us' ? 'us' : 'eu';
  const apiBase = region === 'us' ? 'https://api.vapi.ai' : 'https://api.eu.vapi.ai';
  const webhookBase = (
    process.env.VAPI_WEBHOOK_BASE_URL
    || process.env.PUBLIC_WEBHOOK_BASE_URL
    || process.env.WEBHOOK_BASE_URL
    || ''
  ).replace(/\/$/, '');

  if (!webhookBase || webhookBase.includes('127.0.0.1') || webhookBase.includes('localhost')) {
    console.warn('WARNING: VAPI_WEBHOOK_BASE_URL should be a public HTTPS URL for tool/transcript webhooks.');
    console.warn('For local pilot, start a tunnel (cloudflared/ngrok) and set VAPI_WEBHOOK_BASE_URL first.');
  }

  const line = loadSyncedLine();
  const { decryptSecret } = await import('../server/crypto');
  const sipUsername = String(line.sipUsername || process.env.SOHO66_SIP_USERNAME || '');
  const sipPasswordRaw = String(line.sipPassword || process.env.SOHO66_SIP_PASSWORD || '');
  const sipPassword = decryptSecret(sipPasswordRaw) || sipPasswordRaw;
  const did = String(line.did || process.env.SOHO66_FROM_NUMBER || '');
  const domain = String(line.sipDomain || process.env.SOHO66_SIP_DOMAIN || 'sbc.soho66.co.uk');
  const numberE164 = toE164Uk(did);

  if (!sipUsername || !sipPassword || !did) {
    throw new Error('Soho66 sipUsername/sipPassword/did missing from phone line');
  }

  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  console.log(`[vapi:setup] region=${region} api=${apiBase}`);
  console.log(`[vapi:setup] trunk ${sipUsername}@${domain}:8060 → ${numberE164}`);
  console.log(`[vapi:setup] webhook=${webhookBase || '(none)'}`);

  // 1) BYO SIP trunk — keep inboundEnabled:false when gateway `ip` is a hostname (Vapi requires
  // IPv4 for inbound gateways). Inbound calls arrive by Soho66 forwarding the DID to
  // sip:<E164>@<credentialId>.sip[.eu].vapi.ai — same Soho66 SIP auth, no extra account.
  const trunkBody = {
    provider: 'byo-sip-trunk',
    name: 'Builder Diddies Soho66 Cynthia',
    gateways: [
      {
        ip: domain,
        port: Number(process.env.SOHO66_SIP_PORT || 8060),
        inboundEnabled: false,
        outboundEnabled: true,
        outboundProtocol: 'udp',
      },
    ],
    outboundLeadingPlusEnabled: true,
    outboundAuthenticationPlan: {
      authUsername: sipUsername,
      authPassword: sipPassword,
    },
  };

  const trunkRes = await fetch(`${apiBase}/credential`, {
    method: 'POST',
    headers,
    body: JSON.stringify(trunkBody),
  });
  const trunkText = await trunkRes.text();
  if (!trunkRes.ok) {
    console.error('Trunk create failed', trunkRes.status, trunkText.slice(0, 600));
    process.exit(1);
  }
  const trunk = JSON.parse(trunkText) as { id: string };
  console.log('[vapi:setup] credentialId=', trunk.id);

  // 2) Import phone number
  const phoneBody = {
    provider: 'byo-phone-number',
    name: 'Builder Diddies Soho66 DID',
    number: numberE164,
    numberE164CheckEnabled: true,
    credentialId: trunk.id,
    serverUrl: webhookBase ? `${webhookBase}/webhooks/vapi` : undefined,
  };
  const phoneRes = await fetch(`${apiBase}/phone-number`, {
    method: 'POST',
    headers,
    body: JSON.stringify(phoneBody),
  });
  const phoneText = await phoneRes.text();
  if (!phoneRes.ok) {
    console.error('Phone number create failed', phoneRes.status, phoneText.slice(0, 600));
    process.exit(1);
  }
  const phone = JSON.parse(phoneText) as { id: string };
  console.log('[vapi:setup] phoneNumberId=', phone.id);

  // 3) Optional: create a placeholder assistant (outbound uses transient assistant)
  let assistantId = process.env.VAPI_ASSISTANT_ID?.trim() || '';
  if (!assistantId) {
    const asstRes = await fetch(`${apiBase}/assistant`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Cynthia Builder Diddies (placeholder)',
        firstMessage: "Hi, it's Cynthia from Builder Diddies — how are you getting on?",
        model: {
          provider: 'openai',
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: 'You are Cynthia for Builder Diddies UK. Speak concise British English. Real prompts are injected per call by Builder Diddies.',
            },
          ],
        },
        voice: {
          provider: '11labs',
          voiceId: process.env.VAPI_ELEVENLABS_VOICE_ID
            || process.env.ELEVENLABS_VOICE_ID
            || 'EQx6HGDYjkDpcli6vorJ',
          model: process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5',
          stability: 0.35,
          similarityBoost: 0.8,
          style: 0.45,
          optimizeStreamingLatency: 3,
        },
        serverUrl: webhookBase ? `${webhookBase}/webhooks/vapi` : undefined,
      }),
    });
    const asstText = await asstRes.text();
    if (asstRes.ok) {
      assistantId = String((JSON.parse(asstText) as { id: string }).id);
      console.log('[vapi:setup] assistantId=', assistantId);
    } else {
      console.warn('[vapi:setup] assistant create skipped', asstRes.status, asstText.slice(0, 300));
    }
  }

  const updates: Record<string, string> = {
    VOICE_PROVIDER: 'vapi',
    VAPI_REGION: region,
    VAPI_SIP_CREDENTIAL_ID: trunk.id,
    VAPI_PHONE_NUMBER_ID: phone.id,
    ...(assistantId ? { VAPI_ASSISTANT_ID: assistantId } : {}),
    ...(webhookBase ? { VAPI_WEBHOOK_BASE_URL: webhookBase } : {}),
  };

  upsertEnv(join(root, '.env'), updates);
  const deployEnv = join(root, '..', 'Bathroom Sales Estimation Platform', '.cursor', 'local', 'deploy.env');
  try {
    upsertEnv(deployEnv, updates);
  } catch {
    console.warn('[vapi:setup] could not write frontend deploy.env');
  }

  console.log('\n[vapi:setup] done. Next:');
  console.log('  1. Ensure VAPI_WEBHOOK_BASE_URL is public HTTPS');
  console.log('  2. Restart API: npm run dev');
  console.log('  3. Dial Emma: POST /api/calls/outbound { to: "+447576442345", template: "lead_callback" }');
  console.log('  4. If outbound fails with SIP auth/REGISTER errors, Soho66 needs Telnyx/DIDLogic BYOC instead.');
  console.log(`  Inbound (later): forward Soho66 DID to sip:${numberE164}@${trunk.id}.sip.${region === 'eu' ? 'eu.' : ''}vapi.ai`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
