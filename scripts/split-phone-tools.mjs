/**
 * Split server/phone/phone-tools.ts ? server/phone/tools/*
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'server/phone/phone-tools.ts');
const outDir = path.join(root, 'server/phone/tools');
fs.mkdirSync(outDir, { recursive: true });

const lines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/);
const slice = (a, b) => lines.slice(a - 1, b).join('\n');
const lift = (s) =>
  s
    .replace(/from '\.\.\//g, "from '../../")
    .replace(/from '\.\//g, "from '../")
    .replace(/from "\.\.\//g, 'from "../../')
    .replace(/from "\.\//g, 'from "../');

const header = lift(slice(1, 33));

function exportify(body) {
  return body.replace(/^(function |async function |const |type |interface )/gm, 'export $1');
}

// firstString helper used by leads + execute — put in util
fs.writeFileSync(
  path.join(outDir, 'util.ts'),
  `${exportify(slice(35, 41))}
`,
);

fs.writeFileSync(
  path.join(outDir, 'leads.ts'),
  `${header}
import { firstString } from './util';

${exportify(slice(43, 150))}
`,
);

fs.writeFileSync(
  path.join(outDir, 'catalog.ts'),
  `${header}

${exportify(slice(152, 689))}
`,
);

fs.writeFileSync(
  path.join(outDir, 'execute.ts'),
  `${header}
import { firstString } from './util';
import { captureOrUpdateLead, normalizeDialableE164 } from './leads';
import { PHONE_TOOLS, PHONE_AUTO_ACTIONS } from './catalog';

${exportify(slice(691, lines.length))}
`,
);

fs.writeFileSync(
  srcPath,
  `/** Phone tools — implementation in ./tools/ */
export { normalizeDialableE164, captureOrUpdateLead } from './tools/leads';
export { PHONE_TOOLS, PHONE_AUTO_ACTIONS } from './tools/catalog';
export { executePhoneTool, getOpenRecruitmentJobs } from './tools/execute';
`,
);

console.log('phone-tools split done');
