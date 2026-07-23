/**
 * Phase 3C: split orchestrator-handler.ts into server/ai/orchestrator/*
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'server/ai/orchestrator-handler.ts');
const outDir = path.join(root, 'server/ai/orchestrator');
fs.mkdirSync(outDir, { recursive: true });

const full = fs.readFileSync(srcPath, 'utf8');
const lines = full.split(/\r?\n/);
const slice = (start, end) => lines.slice(start - 1, end).join('\n');

const sharedImports = `import {
  isValidServerTradeId,
  TRADE_EXTRACTABLE_FIELDS,
  TRADE_PLAYBOOK_PHASES,
  TRADE_REGISTRY,
  TRADE_IDS_CSV,
} from '../../trade-registry';
import { getDataStore } from '../../data-store';
import {
  assessExtraFromVision,
  assessProgressFromVision,
  resolvePhotoUrlsFromContext,
} from '../vision-handler';
import { canExecuteActionForRole, filterActionsForRole, getRequestRole, isGenericTool } from '../../role-permissions';
import { resolveSystemPrompt } from '../orchestrator-prompt';
import {
  executeCustomerTool,
  executeServerReadTool,
  executeUpdateLeadStatus,
  SERVER_READ_TOOLS,
} from '../../orchestrator-tool-exec';
import { PHONE_TOOLS, executePhoneTool, PHONE_AUTO_ACTIONS } from '../../phone-tools';
import {
  RESTAURANT_TOOL_DEFS,
  RESTAURANT_TOOL_NAMES,
  executeRestaurantTool,
} from '../restaurant-ai-tools';
import type {
  OrchestratorAction,
  OrchestratorMessage,
  OrchestratorMode,
  OrchestratorRequest,
  OrchestratorResult,
} from '../orchestrator-types';
import { PLANNING_ACTION_NAMES, PLANNING_TOOLS } from '../planning-tools';
import { GAP_AUTO_ACTIONS, GAP_CLOSING_TOOLS } from '../gap-closing-tools';
import { expandFacadeCall, FACADE_TOOLS, FACADE_WEB_STAFF_MODES, isFacadeEnabled } from '../tool-facade';
import {
  buildClarifyIntro,
  classifyTaskIntent,
  isProceedMessage,
  shouldClarifyBeforeExecute,
} from '../../task-planner';
`;

function exportTopLevel(body) {
  return body
    .replace(/^function /gm, 'export function ')
    .replace(/^const /gm, 'export const ')
    .replace(/^async function /gm, 'export async function ')
    .replace(/^interface /gm, 'export interface ');
}

// 47–1578: hasPlanningContext + tool arrays
fs.writeFileSync(
  path.join(outDir, 'tool-catalog.ts'),
  `${sharedImports}\n\n${exportTopLevel(slice(47, 1578))}\n`,
);

// 1580–1661: sanitize + getToolsForMode
fs.writeFileSync(
  path.join(outDir, 'tools-for-mode.ts'),
  `import type { OrchestratorMode, OrchestratorRequest } from '../orchestrator-types';
import { canExecuteActionForRole, getRequestRole, isGenericTool } from '../../role-permissions';
import { PLANNING_TOOLS } from '../planning-tools';
import { GAP_CLOSING_TOOLS } from '../gap-closing-tools';
import { FACADE_TOOLS, FACADE_WEB_STAFF_MODES, isFacadeEnabled } from '../tool-facade';
import { PHONE_TOOLS } from '../../phone-tools';
import {
  hasPlanningContext,
  GENERIC_TOOLS,
  STAFF_TOOLS,
  CUSTOMER_TOOLS,
  EMAIL_TOOLS,
  CONTRACT_TOOLS,
  PROJECT_TOOLS,
  FOREMAN_TOOLS,
  COSTING_TOOLS,
  ACCOUNTS_TOOLS,
  LEAD_CYCLE_TOOLS,
  NAVIGATION_TOOLS,
  RESTAURANT_TOOLS,
} from './tool-catalog';

${exportTopLevel(slice(1580, 1661))}
`,
);

fs.writeFileSync(
  path.join(outDir, 'auto-actions.ts'),
  `import { PHONE_AUTO_ACTIONS } from '../../phone-tools';
import { PLANNING_ACTION_NAMES } from '../planning-tools';
import { GAP_AUTO_ACTIONS } from '../gap-closing-tools';

${exportTopLevel(slice(1663, 1711))}
`,
);

// Rest of file from applyRoleGate through end — but strip trailing empty
const handleBody = exportTopLevel(slice(1713, lines.length));
fs.writeFileSync(
  path.join(outDir, 'handle.ts'),
  `${sharedImports}
import {
  hasPlanningContext,
  MAX_TOOL_ROUNDS,
  GENERIC_TOOLS,
  STAFF_TOOLS,
  CUSTOMER_TOOLS,
  EMAIL_TOOLS,
  CONTRACT_TOOLS,
  PROJECT_TOOLS,
  FOREMAN_TOOLS,
  COSTING_TOOLS,
  ACCOUNTS_TOOLS,
  LEAD_CYCLE_TOOLS,
  NAVIGATION_TOOLS,
  RESTAURANT_TOOLS,
} from './tool-catalog';
import { getToolsForMode, sanitizeToolsForOpenAI } from './tools-for-mode';
import { AUTO_ACTION_NAMES } from './auto-actions';

export type { OrchestratorAction, OrchestratorRequest, OrchestratorResult } from '../orchestrator-types';
export { getToolsForMode, sanitizeToolsForOpenAI } from './tools-for-mode';
export { AUTO_ACTION_NAMES } from './auto-actions';

${handleBody}
`,
);

fs.writeFileSync(
  srcPath,
  `/**
 * Public orchestrator surface — implementation in ./orchestrator/.
 */
export type { OrchestratorAction, OrchestratorRequest, OrchestratorResult } from './orchestrator-types';
export { sanitizeToolsForOpenAI, getToolsForMode } from './orchestrator/tools-for-mode';
export { AUTO_ACTION_NAMES } from './orchestrator/auto-actions';
export { handleOrchestrator } from './orchestrator/handle';
`,
);

console.log('orchestrator split done');
