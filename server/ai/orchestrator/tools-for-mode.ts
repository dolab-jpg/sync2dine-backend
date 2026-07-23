import type { OrchestratorMode, OrchestratorRequest } from '../orchestrator-types';
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

export const FORBIDDEN_TOP_LEVEL_SCHEMA_KEYS = new Set([
  'oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not',
]);

/** Ensure OpenAI function parameters are a plain object schema (no top-level combinators). */
export function sanitizeToolsForOpenAI<T extends { type: 'function'; function: { name: string; parameters?: Record<string, unknown> } }>(
  tools: T[],
): T[] {
  return tools.map((tool) => {
    const parameters = { ...(tool.function.parameters ?? {}) } as Record<string, unknown>;
    for (const key of FORBIDDEN_TOP_LEVEL_SCHEMA_KEYS) {
      delete parameters[key];
    }
    if (parameters.type !== 'object') {
      parameters.type = 'object';
    }
    if (!parameters.properties || typeof parameters.properties !== 'object') {
      parameters.properties = {};
    }
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters,
      },
    };
  });
}

export function getToolsForMode(mode: OrchestratorMode, body?: OrchestratorRequest) {
  const hasProject = Boolean(body?.projectContext?.projectId);
  const planning = hasPlanningContext(body);

  // AI_TOOL_FACADE: web-staff modes get the 12 domain facade tools instead of
  // the full schema list. Phone and customer/cyrus packs are never affected.
  // Role/permission gating still happens post-expansion on canonical action
  // names (applyRoleGate / AUTO_ACTION_NAMES), so no per-tool role filter here.
  if (isFacadeEnabled() && FACADE_WEB_STAFF_MODES.has(mode)) {
    const planningActive = mode === 'planning' || planning;
    const facadeTools = planningActive
      ? FACADE_TOOLS
      : FACADE_TOOLS.filter((tool) => tool.function.name !== 'managePlanning');
    return sanitizeToolsForOpenAI(facadeTools);
  }

  let tools;
  if (mode === 'planning') {
    tools = [...GENERIC_TOOLS, ...STAFF_TOOLS, ...RESTAURANT_TOOLS, ...NAVIGATION_TOOLS, ...PLANNING_TOOLS, ...GAP_CLOSING_TOOLS];
  } else if (mode === 'staff') {
    tools = hasProject
      ? [...GENERIC_TOOLS, ...STAFF_TOOLS, ...RESTAURANT_TOOLS, ...EMAIL_TOOLS, ...CONTRACT_TOOLS, ...PROJECT_TOOLS, ...COSTING_TOOLS, ...ACCOUNTS_TOOLS, ...LEAD_CYCLE_TOOLS, ...NAVIGATION_TOOLS, ...GAP_CLOSING_TOOLS]
      : [...GENERIC_TOOLS, ...STAFF_TOOLS, ...RESTAURANT_TOOLS, ...EMAIL_TOOLS, ...CONTRACT_TOOLS, ...COSTING_TOOLS, ...ACCOUNTS_TOOLS, ...LEAD_CYCLE_TOOLS, ...NAVIGATION_TOOLS, ...GAP_CLOSING_TOOLS];
  } else if (mode === 'project' || mode === 'foreman') {
    tools = [...GENERIC_TOOLS, ...STAFF_TOOLS, ...RESTAURANT_TOOLS, ...EMAIL_TOOLS, ...CONTRACT_TOOLS, ...PROJECT_TOOLS, ...FOREMAN_TOOLS, ...COSTING_TOOLS, ...ACCOUNTS_TOOLS, ...LEAD_CYCLE_TOOLS, ...NAVIGATION_TOOLS, ...GAP_CLOSING_TOOLS];
  } else if (mode === 'customer' || mode === 'cyrus') {
    tools = [...GENERIC_TOOLS, ...CUSTOMER_TOOLS];
  } else if (mode === 'phone') {
    tools = [
      ...GENERIC_TOOLS,
      ...CUSTOMER_TOOLS,
      ...PHONE_TOOLS,
      ...RESTAURANT_TOOLS.filter((t) => t.function.name !== 'getMenu'),
    ];
  } else {
    tools = [...GENERIC_TOOLS, ...STAFF_TOOLS, ...RESTAURANT_TOOLS, ...EMAIL_TOOLS, ...CONTRACT_TOOLS, ...PROJECT_TOOLS, ...FOREMAN_TOOLS, ...COSTING_TOOLS, ...ACCOUNTS_TOOLS, ...LEAD_CYCLE_TOOLS, ...NAVIGATION_TOOLS, ...GAP_CLOSING_TOOLS];
  }

  if (planning && mode !== 'planning') {
    tools = [...tools, ...PLANNING_TOOLS];
  }

  // Generic tools are always available; specialized tools are role-gated.
  if (body) {
    const role = getRequestRole(body);
    if (role !== 'unknown') {
      tools = tools.filter((tool) =>
        isGenericTool(tool.function.name) || canExecuteActionForRole(role, tool.function.name)
      );
    }
  }
  return sanitizeToolsForOpenAI(tools);
}
