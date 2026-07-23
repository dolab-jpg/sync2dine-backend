#!/usr/bin/env node
/**
 * Tree-wide runtime discovery for Sync2Dine backend (+ optional FE sibling).
 * Evidence only  reviewed registries classify findings.
 *
 * Usage: node scripts/extract-registries.mjs [--write-baseline]
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BE_ROOT = join(__dirname, '..');
const FE_ROOT = join(BE_ROOT, '..', 'sync2dine-frontend');
const OUT = join(BE_ROOT, 'docs', '_generated');
const writeBaseline = process.argv.includes('--write-baseline');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'data',
  '.wwebjs_auth',
  'coverage',
  '_generated',
]);

function walk(dir, acc = [], opts = {}) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (opts.skipQuarantineContents && name === '_quarantine') {
        acc.push({ path: full, quarantineDir: true });
        continue;
      }
      walk(full, acc, opts);
    } else if (/\.(ts|tsx|js|mjs|mts)$/.test(name) && !name.endsWith('.d.ts')) {
      acc.push({ path: full });
    }
  }
  return acc;
}

function rel(p, root = BE_ROOT) {
  return relative(root, p).replace(/\\/g, '/');
}

function fingerprint(obj) {
  const sorted = JSON.stringify(obj, Object.keys(obj).sort());
  return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

const tools = [];
const aiSurfaces = [];
const workers = [];
const routes = [];
const dynamicImports = [];
const quarantineFiles = [];
const envGates = [];
const allowlists = [];

const PRIORITY_TOOL_HINTS = [
  'phone/tools/catalog',
  'phone/phone-brain',
  'phone/sally-sales-phone',
  'sally/tools',
  'sally-receptionist',
  'ai/tool-facade',
  'ai/gap-closing-tools',
  'ai/orchestrator/tool-catalog',
  'ai/restaurant-ai-tools',
  'ai/planning-tools',
];

function scanFile(filePath, root = BE_ROOT) {
  const r = rel(filePath, root);
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  if (r.includes('_quarantine/')) {
    quarantineFiles.push(r);
  }

  // Tool schema names: name: 'foo' near type: 'function'
  const nameRe = /name:\s*['"`]([a-zA-Z][a-zA-Z0-9_]{2,})['"`]/g;
  let m;
  const isPriority = PRIORITY_TOOL_HINTS.some((h) => r.includes(h));
  const looksLikeToolFile =
    isPriority ||
    /type:\s*['"`]function['"`]/.test(text) ||
    /ChatCompletionTool|function:\s*\{/.test(text) ||
    /TOOLS\s*=/.test(text);

  if (looksLikeToolFile) {
    const names = new Set();
    while ((m = nameRe.exec(text))) {
      const n = m[1];
      if (
        [
          'string',
          'number',
          'boolean',
          'object',
          'array',
          'function',
          'null',
          'type',
          'required',
          'properties',
          'description',
          'parameters',
          'items',
          'enum',
          'additionalProperties',
        ].includes(n)
      ) {
        continue;
      }
      // Heuristic: camelCase identifiers typical of tools
      if (/^[a-z][a-zA-Z0-9]*$/.test(n) && /[A-Z]/.test(n)) {
        names.add(n);
      } else if (
        [
          'endCall',
          'getMenu',
          'readData',
          'writeData',
          'navigate',
          'bookDemo',
          'sendSms',
        ].includes(n)
      ) {
        names.add(n);
      }
    }
    for (const name of names) {
      tools.push({
        name,
        file: r,
        priority: isPriority,
        source: 'schema_scan',
      });
    }
  }

  // Allowlist string arrays of tool-like names
  if (/PHONE_|STAFF_|PRE_AUTH_|SALLY_|TOOL_NAMES|ALLOWED_ACTIONS|AUTO_ACTIONS/.test(text)) {
    const strArr = text.matchAll(/['"`]([a-z][a-zA-Z0-9]{3,})['"`]/g);
    const candidates = [];
    for (const sm of strArr) {
      if (/[A-Z]/.test(sm[1])) candidates.push(sm[1]);
    }
    if (candidates.length >= 3) {
      allowlists.push({ file: r, sampleNames: [...new Set(candidates)].slice(0, 40) });
    }
  }

  // Routes
  const routeRe = /pathname\.startsWith\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  while ((m = routeRe.exec(text))) {
    routes.push({ prefix: m[1], file: r, kind: 'startsWith' });
  }
  const eqRe = /pathname\s*===\s*['"`]([^'"`]+)['"`]/g;
  while ((m = eqRe.exec(text))) {
    routes.push({ prefix: m[1], file: r, kind: 'exact' });
  }

  // Handlers mounted pattern
  if (/export\s+(async\s+)?function\s+handle\w+/.test(text)) {
    const hm = text.matchAll(/export\s+(?:async\s+)?function\s+(handle\w+)/g);
    for (const h of hm) {
      routes.push({ handler: h[1], file: r, kind: 'handler_export' });
    }
  }

  // Workers / pollers
  const startRe = /(?:export\s+)?(?:async\s+)?function\s+(start\w+|init\w+)\s*\(/g;
  while ((m = startRe.exec(text))) {
    workers.push({ name: m[1], file: r, kind: 'function' });
  }
  if (/setInterval\s*\(/.test(text)) {
    workers.push({ name: 'setInterval', file: r, kind: 'interval' });
  }

  // Dynamic imports
  const dynRe = /import\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  while ((m = dynRe.exec(text))) {
    dynamicImports.push({ specifier: m[1], file: r });
  }

  // BrainId
  if (/BrainId|brains\/(sally|judie)/.test(text) && r.includes('brains')) {
    if (/id:\s*['"`](sally|judie)['"`]/.test(text) || /BrainId\s*=/.test(text)) {
      aiSurfaces.push({ id: 'brain_ref', file: r, note: 'brains package reference' });
    }
  }

  // Env gates
  const envRe = /process\.env\.([A-Z][A-Z0-9_]*(?:ENABLED|DISABLE|FACADE|IVR|VOICE|WHATSAPP|META)[A-Z0-9_]*)/g;
  while ((m = envRe.exec(text))) {
    envGates.push({ env: m[1], file: r });
  }
  const envRe2 =
    /process\.env\.(AI_TOOL_FACADE|IVR_ENABLED|WHATSAPP_META_ENABLED|DISABLE_SALES_BRAIN_WORKER|VOICE_PROVIDER|DISABLE_\w+)/g;
  while ((m = envRe2.exec(text))) {
    envGates.push({ env: m[1], file: r });
  }
}

// --- Scan backend server ---
const beFiles = walk(join(BE_ROOT, 'server'), [], { skipQuarantineContents: false });
for (const f of beFiles) {
  if (f.quarantineDir) continue;
  scanFile(f.path, BE_ROOT);
}

// Quarantine listing
const qDir = join(BE_ROOT, 'server', '_quarantine');
if (existsSync(qDir)) {
  for (const f of walk(qDir)) {
    quarantineFiles.push(rel(f.path));
  }
}

// index.ts boot workers (explicit)
const indexPath = join(BE_ROOT, 'server', 'index.ts');
const indexText = readFileSync(indexPath, 'utf8');
const bootWorkers = [];
for (const name of [
  'startMailboxPoller',
  'startOutboundWorker',
  'startConnectorQueueWorker',
  'startSalesBrainWorker',
  'startSallyKnowledgeWorker',
  'warmSallyKnowledgeCache',
  'startScheduledMessageWorker',
  'startWeeklyBillingWorker',
  'startCodeFixWorker',
  'initWWebClient',
]) {
  if (indexText.includes(name)) {
    bootWorkers.push({ name, caller: 'server/index.ts', status: 'boot' });
  }
}

// Brain packages
const brains = [];
for (const id of ['sally', 'judie', 'cynthia']) {
  const p = join(BE_ROOT, 'server', 'brains', id, 'index.ts');
  if (existsSync(p)) brains.push({ id, file: `server/brains/${id}/index.ts`, kind: 'phone_brain' });
}

// Dedupe tools
const toolMap = new Map();
for (const t of tools) {
  const key = `${t.name}@@${t.file}`;
  if (!toolMap.has(key)) toolMap.set(key, t);
}
const toolsDeduped = [...toolMap.values()].sort((a, b) =>
  a.name === b.name ? a.file.localeCompare(b.file) : a.name.localeCompare(b.name),
);

const uniqueToolNames = [...new Set(toolsDeduped.map((t) => t.name))].sort();
const uniqueRoutePrefixes = [
  ...new Set(routes.filter((r) => r.prefix).map((r) => r.prefix)),
].sort();

const toolsOut = {
  generatedAt: new Date().toISOString(),
  toolCount: uniqueToolNames.length,
  occurrenceCount: toolsDeduped.length,
  uniqueNames: uniqueToolNames,
  occurrences: toolsDeduped,
  allowlistFiles: allowlists,
};

const aiOut = {
  generatedAt: new Date().toISOString(),
  phoneBrains: brains,
  brainRefs: aiSurfaces,
  envGates: [...new Map(envGates.map((e) => [`${e.env}:${e.file}`, e])).values()],
  note: 'Classification belongs in AI_REGISTRY.md  this is discovery evidence only.',
};

const workersOut = {
  generatedAt: new Date().toISOString(),
  bootFromIndex: bootWorkers,
  discoveredFunctions: workers,
  dynamicImports: dynamicImports.filter((d) =>
    /worker|poller|whatsapp|code-fix|billing|scheduled/i.test(d.specifier),
  ),
};

const routesOut = {
  generatedAt: new Date().toISOString(),
  prefixes: uniqueRoutePrefixes,
  details: routes,
  handlers: routes.filter((r) => r.handler),
};

const summary = {
  generatedAt: new Date().toISOString(),
  beRoot: 'sync2dine-backend',
  counts: {
    uniqueTools: uniqueToolNames.length,
    toolOccurrences: toolsDeduped.length,
    routePrefixes: uniqueRoutePrefixes.length,
    bootWorkers: bootWorkers.length,
    quarantineFiles: quarantineFiles.length,
    dynamicImports: dynamicImports.length,
    envGates: envGates.length,
    phoneBrains: brains.length,
  },
  quarantineFiles: [...new Set(quarantineFiles)].sort(),
  fingerprints: {},
};

summary.fingerprints.tools = fingerprint({ names: uniqueToolNames });
summary.fingerprints.routes = fingerprint({ prefixes: uniqueRoutePrefixes });
summary.fingerprints.bootWorkers = fingerprint({ boot: bootWorkers.map((w) => w.name).sort() });
summary.fingerprints.brains = fingerprint({ brains: brains.map((b) => b.id).sort() });

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'tools-discovered.json'), JSON.stringify(toolsOut, null, 2));
writeFileSync(join(OUT, 'ai-surfaces-discovered.json'), JSON.stringify(aiOut, null, 2));
writeFileSync(join(OUT, 'workers-discovered.json'), JSON.stringify(workersOut, null, 2));
writeFileSync(join(OUT, 'routes-discovered.json'), JSON.stringify(routesOut, null, 2));
writeFileSync(join(OUT, 'runtime-discovery-summary.json'), JSON.stringify(summary, null, 2));

const baselinePath = join(OUT, 'reviewed-baseline.json');
const baselinePayload = {
  updatedAt: new Date().toISOString(),
  note: 'Reviewed fingerprint of discovery. Update deliberately when runtime architecture changes.',
  fingerprints: summary.fingerprints,
  bootWorkers: bootWorkers.map((w) => w.name).sort(),
  phoneBrains: brains.map((b) => b.id).sort(),
  routePrefixCount: uniqueRoutePrefixes.length,
  uniqueToolCount: uniqueToolNames.length,
};

if (writeBaseline || !existsSync(baselinePath)) {
  writeFileSync(baselinePath, JSON.stringify(baselinePayload, null, 2));
  console.log('Wrote reviewed-baseline.json');
}

console.log(
  JSON.stringify(
    {
      out: rel(OUT),
      ...summary.counts,
      fingerprints: summary.fingerprints,
    },
    null,
    2,
  ),
);
