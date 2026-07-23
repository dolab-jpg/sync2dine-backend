#!/usr/bin/env node
/**
 * Agent map + discovery baseline check (backend).
 * Compares extract fingerprints to reviewed-baseline.json.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BE_ROOT = join(__dirname, '..');
const FE_ROOT = join(BE_ROOT, '..', 'sync2dine-frontend');
const GEN = join(BE_ROOT, 'docs', '_generated');
const errors = [];

function fail(msg) {
  errors.push(msg);
}

const requiredDocs = [
  'docs/AI_REGISTRY.md',
  'docs/TOOL_REGISTRY.md',
  'docs/WORKERS.md',
  'docs/ROUTE_MAP.md',
  'docs/LEGACY_ALIASES.md',
  'docs/PHONE_ARCHITECTURE.md',
  'docs/SALLY_ARCHITECTURE.md',
  'docs/adr/001-phone-brains-sally-judie.md',
  'docs/adr/006-generated-vs-reviewed.md',
  'docs/adr/007-quarantine-boundaries.md',
  'AGENTS.md',
  'server/index.ts',
  'server/phone/vapi-routes.ts',
  'server/orders/orders-routes.ts',
  'server/sally/web-chat.ts',
];

for (const p of requiredDocs) {
  if (!existsSync(join(BE_ROOT, p))) fail(`Missing ${p}`);
}

const genFiles = [
  'tools-discovered.json',
  'ai-surfaces-discovered.json',
  'workers-discovered.json',
  'routes-discovered.json',
  'runtime-discovery-summary.json',
  'reviewed-baseline.json',
];
for (const f of genFiles) {
  if (!existsSync(join(GEN, f))) fail(`Missing docs/_generated/${f} — run npm run extract:registries`);
}

// Re-run extract to temp? Better: run extract in-place then compare baseline
const extract = spawnSync(process.execPath, [join(__dirname, 'extract-registries.mjs')], {
  cwd: BE_ROOT,
  encoding: 'utf8',
});
if (extract.status !== 0) {
  fail(`extract:registries failed: ${extract.stderr || extract.stdout}`);
} else {
  const summary = JSON.parse(readFileSync(join(GEN, 'runtime-discovery-summary.json'), 'utf8'));
  const baseline = JSON.parse(readFileSync(join(GEN, 'reviewed-baseline.json'), 'utf8'));
  const keys = ['tools', 'routes', 'bootWorkers', 'brains'];
  for (const k of keys) {
    if (summary.fingerprints[k] !== baseline.fingerprints[k]) {
      fail(
        `Runtime discovery changed (${k}: ${baseline.fingerprints[k]} → ${summary.fingerprints[k]}).\n` +
          `Review the generated diff and update the appropriate registry,\n` +
          `or explicitly record the intentional removal or replacement.\n` +
          `Then: npm run extract:registries:baseline`,
      );
    }
  }
  if (summary.counts.uniqueTools < 50) fail('Tool discovery produced suspiciously few tools');
  if (summary.counts.bootWorkers < 5) fail('Boot worker discovery too small');
  if (summary.counts.phoneBrains !== 3) fail('Expected exactly 3 phone brains');
}

// Quarantine not imported by index
const indexTs = readFileSync(join(BE_ROOT, 'server/index.ts'), 'utf8');
if (indexTs.includes('_quarantine')) fail('server/index.ts must not import _quarantine');
if (!indexTs.includes('handleVapiRoutes') || !indexTs.includes('handleOrdersRoutes')) {
  fail('index.ts missing critical handlers');
}

// Stub banner
const stub = readFileSync(join(BE_ROOT, 'server/vapi-routes.ts'), 'utf8');
if (!stub.includes('RE-EXPORT STUB')) fail('vapi-routes.ts missing RE-EXPORT STUB');

// code-fix repos
const codeFix = readFileSync(join(BE_ROOT, 'server/code-fix-handler.ts'), 'utf8');
if (/tradepro-(frontend|backend)/.test(codeFix)) fail('code-fix-handler still references tradepro-*');

// Negative: deploy scripts disabled on FE if present
if (existsSync(join(FE_ROOT, 'scripts/deploy-nginx.sh'))) {
  const nginx = readFileSync(join(FE_ROOT, 'scripts/deploy-nginx.sh'), 'utf8');
  if (!/disabled|ERROR:/.test(nginx)) fail('FE deploy-nginx.sh not hard-disabled');
}
if (existsSync(join(FE_ROOT, 'scripts/deploy-vps.sh'))) {
  const vps = readFileSync(join(FE_ROOT, 'scripts/deploy-vps.sh'), 'utf8');
  if (!/disabled|ERROR:/.test(vps)) fail('FE deploy-vps.sh not hard-disabled');
}

// DEPLOYMENT_MAP must not call nginx authoritative
if (existsSync(join(FE_ROOT, 'docs/DEPLOYMENT_MAP.md'))) {
  const dep = readFileSync(join(FE_ROOT, 'docs/DEPLOYMENT_MAP.md'), 'utf8');
  if (!dep.includes('push-live-local')) fail('DEPLOYMENT_MAP missing push-live-local');
  if (/authoritative.*deploy-nginx|deploy-nginx.*authoritative/i.test(dep)) {
    fail('DEPLOYMENT_MAP must not mark deploy-nginx as authoritative');
  }
}

if (errors.length) {
  console.error('check:agent-maps FAILED:');
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}
console.log('check:agent-maps OK (backend)');
