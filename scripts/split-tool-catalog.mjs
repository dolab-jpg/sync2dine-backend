import fs from 'fs';

const catalogPath = 'server/ai/orchestrator/tool-catalog.ts';
const src = fs.readFileSync(catalogPath, 'utf8');
const lines = src.split(/\r?\n/);

const markers = [
  { name: 'generic', start: 'export const GENERIC_TOOLS' },
  { name: 'staff', start: 'export const STAFF_TOOLS' },
  { name: 'contract', start: 'export const CONTRACT_TOOLS' },
  { name: 'project', start: 'export const PROJECT_TOOLS' },
  { name: 'comms', start: 'export const COMMS_TOOLS' },
  { name: 'ops', start: 'export const OPS_TOOLS' },
  { name: 'planning', start: 'export const PLANNING_TOOLS' },
  { name: 'vision', start: 'export const VISION_TOOLS' },
  { name: 'customer', start: 'export const CUSTOMER_TOOLS' },
  { name: 'phone', start: 'export const PHONE_TOOLS' },
];

// Find which markers exist
const found = markers
  .map((m) => ({ ...m, idx: lines.findIndex((l) => l.startsWith(m.start)) }))
  .filter((m) => m.idx >= 0)
  .sort((a, b) => a.idx - b.idx);

if (found.length < 2) {
  console.error('not enough markers', found);
  process.exit(1);
}

let importEnd = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('export ') && !lines[i].startsWith('export type')) {
    // keep early helpers like hasPlanningContext / MAX_TOOL_ROUNDS in preamble
    if (lines[i].startsWith('export const GENERIC_TOOLS') || lines[i].startsWith('export const STAFF_TOOLS')) {
      importEnd = i;
      break;
    }
  }
}
// Prefer start of first tool const
importEnd = found[0].idx;

const preamble = lines.slice(0, importEnd).join('\n');
const chunks = [];
for (let i = 0; i < found.length; i++) {
  const start = found[i].idx;
  const end = i + 1 < found.length ? found[i + 1].idx : lines.length;
  chunks.push({ name: found[i].name, body: lines.slice(start, end).join('\n') });
}

const exportNames = [];
for (const chunk of chunks) {
  const file = `server/ai/orchestrator/tool-catalog-${chunk.name}.ts`;
  fs.writeFileSync(file, `${preamble}\n\n${chunk.body}\n`);
  const constMatches = [...chunk.body.matchAll(/^export const ([A-Z0-9_]+)/gm)].map((m) => m[1]);
  exportNames.push(...constMatches);
  console.log(file, chunk.body.split('\n').length, constMatches.join(','));
}

const barrel = `${preamble}\n\n${chunks
  .map((c) => `export * from './tool-catalog-${c.name}';`)
  .join('\n')}\n`;
fs.writeFileSync(catalogPath, barrel);
console.log('barrel exports from', chunks.length, 'files; preamble lines', preamble.split('\n').length);
