/**
 * One-shot: move domain files into server/{phone,orders,ai,billing}/
 * and leave thin re-export stubs at the old root paths.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', 'server');

const groups = {
  phone: [
    'phone-auth.ts', 'phone-billing.ts', 'phone-brain.ts', 'phone-language-friends.ts', 'phone-language.ts',
    'phone-lines.ts', 'phone-number-type.ts', 'phone-orchestrator.ts', 'phone-prompt.ts', 'phone-session.ts',
    'phone-tools.ts', 'phone-voices.ts', 'phone-webhook.ts', 'vapi-assistant.ts', 'vapi-client.ts',
    'vapi-llm-model.ts', 'vapi-routes.ts', 'sally-sales-phone.ts', 'british-voice.ts', 'ivr-handler.ts',
    'spoken-money.ts', 'callback-time.ts', 'transfer-numbers.ts', 'call-provider-refresh.ts',
    'call-recording-store.ts', 'call-recording-backfill.ts', 'lead-call-disposition.ts',
  ],
  orders: [
    'order-service.ts', 'orders-routes.ts', 'food-order-guards.ts', 'menu-routes.ts',
    'reservations-routes.ts', 'reservations-store.ts', 'allergens.ts', 'delivery-areas.ts', 'supabase-orders.ts',
  ],
  ai: [
    'ai-proxy.ts', 'ai-studio-routes.ts', 'orchestrator-handler.ts', 'orchestrator-prompt.ts', 'orchestrator-types.ts',
    'orchestrate-stream.ts', 'staff-ai-handler.ts', 'cynthia-routes.ts', 'cyrus-routes.ts', 'cyrus-handler.ts',
    'cynthia-staff-store.ts', 'conversation-audit.ts', 'agent-routes.ts', 'gap-api-routes.ts', 'gap-closing-tools.ts',
    'tool-facade.ts', 'restaurant-ai-tools.ts', 'planning-ai-handler.ts', 'vision-handler.ts', 'summarize-handler.ts',
    'metered-openai.ts', 'openai-connection.ts', 'llm-connection.ts', 'compose-email-handler.ts',
    'receipt-handler.ts', 'categorize-transaction-handler.ts', 'building-control-handler.ts', 'planning-tools.ts',
    'stt.ts', 'translation-service.ts', 'channel-inbound-handler.ts', 'channel-action-executor.ts', 'channel-writes.ts',
  ],
  billing: [
    'stripe-routes.ts', 'stripe-service.ts', 'stripe-config.ts', 'weekly-billing-routes.ts', 'weekly-billing-worker.ts',
    'weekly-usage-billing.ts', 'org-phone-billing-routes.ts', 'billing-periods.ts', 'quote-checkout.ts',
    'saas-contracts.ts', 'saas-products.ts',
  ],
};

const moved = new Map();

for (const [group, files] of Object.entries(groups)) {
  const dir = path.join(root, group);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const src = path.join(root, file);
    if (!fs.existsSync(src)) {
      console.warn('SKIP missing', file);
      continue;
    }
    // Already a stub? skip
    const existing = fs.readFileSync(src, 'utf8');
    if (existing.trim().startsWith('export * from') && existing.length < 120) {
      console.warn('SKIP already stub', file);
      continue;
    }
    const dest = path.join(dir, file);
    if (fs.existsSync(dest)) {
      console.warn('SKIP dest exists', dest);
      continue;
    }
    fs.renameSync(src, dest);
    moved.set(file.replace(/\.ts$/, ''), group);
    const base = file.replace(/\.ts$/, '');
    fs.writeFileSync(src, `export * from './${group}/${base}';\n`);
    console.log('moved', file, '->', group);
  }
}

function rewriteImports(filePath, group) {
  let text = fs.readFileSync(filePath, 'utf8');
  const groupFiles = new Set(groups[group].map((f) => f.replace(/\.ts$/, '')));
  text = text.replace(/from (['"])\.\/([^'"]+)\1/g, (m, q, spec) => {
    const first = spec.split('/')[0];
    if (groupFiles.has(first)) return m;
    return `from ${q}../${spec}${q}`;
  });
  // dynamic import('./x')
  text = text.replace(/import\((['"])\.\/([^'"]+)\1\)/g, (m, q, spec) => {
    const first = spec.split('/')[0];
    if (groupFiles.has(first)) return m;
    return `import(${q}../${spec}${q})`;
  });
  fs.writeFileSync(filePath, text);
}

for (const [group, files] of Object.entries(groups)) {
  for (const file of files) {
    const p = path.join(root, group, file);
    if (fs.existsSync(p)) rewriteImports(p, group);
  }
}

console.log('done, moved', moved.size);
