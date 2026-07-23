import fs from 'fs';

const handlePath = 'server/ai/orchestrator/handle.ts';
const src = fs.readFileSync(handlePath, 'utf8');
const lines = src.split(/\r?\n/);
const mockIdx = lines.findIndex((l) => l.startsWith('export function buildMockResult'));
const runIdx = lines.findIndex((l) => l.startsWith('export async function runCustomerOrchestrator'));
if (mockIdx < 0 || runIdx < 0) {
  console.error('markers missing', mockIdx, runIdx);
  process.exit(1);
}

let importEnd = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('export ')) {
    importEnd = i;
    break;
  }
}
const imports = lines.slice(0, importEnd).join('\n');
const helpersBody = lines.slice(importEnd, mockIdx).join('\n');
const mockBody = lines.slice(mockIdx, runIdx).join('\n');
const runnersBody = lines.slice(runIdx).join('\n');

fs.writeFileSync('server/ai/orchestrator/helpers.ts', `${imports}\n${helpersBody}\n`);

const helperNames = [
  'applyRoleGate',
  'resolveMode',
  'toMessageRole',
  'safeParseObject',
  'buildActionSummary',
  'buildActionsSummaryText',
  'extractCustomerFromMessage',
  'inferTradesFromText',
  'mockFieldsForTrade',
  'inferRouteFromText',
  'extractSearchQuery',
  'firstString',
  'readAssignedContractors',
  'getTradePhaseSummary',
  'readStringArray',
  'buildChangeOrderFromAssessment',
  'executeVisionTool',
  'summarizeProjectStatus',
  'buildCustomerReplyFromActions',
  'wrapMockResult',
  'staffMockGreetingContent',
  'detectQuoteWonIntent',
  'extractCustomerNameFromMessage',
];

fs.writeFileSync(
  'server/ai/orchestrator/mock.ts',
  `${imports}\nimport {\n  ${helperNames.join(',\n  ')},\n} from './helpers';\n\n${mockBody}\n`,
);

fs.writeFileSync(
  'server/ai/orchestrator/handle.ts',
  `${imports}\nexport * from './helpers';\nexport { buildMockResult } from './mock';\nimport { buildMockResult } from './mock';\nimport {\n  applyRoleGate,\n  resolveMode,\n  toMessageRole,\n  firstString,\n  wrapMockResult,\n  staffMockGreetingContent,\n} from './helpers';\n\n${runnersBody}\n`,
);

console.log({
  helpers: helpersBody.split('\n').length,
  mock: mockBody.split('\n').length,
  runners: runnersBody.split('\n').length,
});
