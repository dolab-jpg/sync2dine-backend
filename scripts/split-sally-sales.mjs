/**
 * Split server/sally-sales.ts ? server/sally/*
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'server/sally-sales.ts');
const outDir = path.join(root, 'server/sally');
fs.mkdirSync(outDir, { recursive: true });

const lines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/);
const slice = (a, b) => lines.slice(a - 1, b).join('\n');
const lift = (s) => s.replace(/from '\.\//g, "from '../").replace(/from "\.\//g, 'from "../');

const header = lift(slice(1, 58));

function exportify(body) {
  return body
    .replace(/^export /gm, 'export ') // already exported
    .replace(/^(type |interface |const |function |async function )/gm, (m) =>
      m.startsWith('export') ? m : `export ${m}`,
    );
}

// offer: persona through isSallySalesCall + draft/terms/checkout
fs.writeFileSync(
  path.join(outDir, 'offer.ts'),
  `${header}\n\n${exportify(slice(60, 349))}\n\n${exportify(slice(1101, 1255))}\n`,
);

// tools block may reference helpers defined earlier in offer — SALLY_PERSONA etc.
fs.writeFileSync(
  path.join(outDir, 'tools.ts'),
  `${header}
import {
  SALLY_PERSONA,
  SALLY_EXCLUSIVE_TOOLS,
} from './offer';

${exportify(slice(351, 1016))}
`,
);

fs.writeFileSync(
  path.join(outDir, 'prompts.ts'),
  `${header}
import { getSallyOfferTerms } from './offer';

${exportify(slice(1018, 1099))}
`,
);

fs.writeFileSync(
  path.join(outDir, 'execute.ts'),
  `${header}
import {
  getSallyOfferTerms,
  resolveSallySessionKey,
  isSallySalesCall,
  getSallyDraftForSession,
  getSallyTermsForSession,
  buildSallyCheckoutHandoff,
  type SallyOfferTerms,
  type SallyTermsRecord,
  SALLY_PERSONA,
} from './offer';
import {
  SALLY_PHONE_TOOLS,
  SALLY_EXTENDED_TOOLS,
  getSallyPhoneSessionChatTools,
  getSallyOrchestratorTools,
  isSallyToolName,
  isSallyExclusiveTool,
} from './tools';
import { buildSallyBrainPrompt, buildSallyChatPrompt, buildSallyWebPrompt } from './prompts';

${exportify(slice(1257, lines.length))}
`,
);

fs.writeFileSync(
  srcPath,
  `/** Sally sales — implementation in ./sally/ */
export {
  SALLY_PERSONA,
  SALLY_EXCLUSIVE_TOOLS,
  getSallyOfferTerms,
  resolveSallySessionKey,
  isSallySalesCall,
  getSallyDraftForSession,
  getSallyTermsForSession,
  buildSallyCheckoutHandoff,
} from './sally/offer';
export type { SallyOfferTerms, SallyTermsRecord } from './sally/offer';
export {
  SALLY_PHONE_TOOLS,
  SALLY_EXTENDED_TOOLS,
  getSallyPhoneSessionChatTools,
  getSallyOrchestratorTools,
  getSallyWebOrchestratorTools,
  isSallyToolName,
  isSallyExclusiveTool,
} from './sally/tools';
export {
  buildSallyBrainPrompt,
  buildSallyChatPrompt,
  buildSallyWebPrompt,
} from './sally/prompts';
export { executeSallyTool, enqueueSallyRetryLeads } from './sally/execute';
export type { SallyToolContext } from './sally/execute';
`,
);

console.log('sally split done');
