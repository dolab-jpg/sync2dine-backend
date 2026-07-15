/**
 * 12-tool web facade tests: schema sanitation, operation→canonical integrity,
 * payload expansion, phone-pack stability, and gate integrity.
 * Run: npm test  (or: npx tsx --test server/tool-facade.test.ts)
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACADE_TOOLS,
  FACADE_TOOL_NAMES,
  FACADE_OPERATION_MAP,
  FACADE_WEB_STAFF_MODES,
  expandFacadeCall,
  isFacadeEnabled,
  isFacadeToolName,
} from './tool-facade';
import {
  AUTO_ACTION_NAMES,
  getToolsForMode,
  sanitizeToolsForOpenAI,
} from './orchestrator-handler';
import { canExecuteActionForRole, filterActionsForRole, type ServerAgentRole } from './role-permissions';
import { PLANNING_ACTION_NAMES } from './planning-tools';
import type { OrchestratorRequest } from './orchestrator-types';

const ORIGINAL_FLAG = process.env.AI_TOOL_FACADE;

function setFlag(value: string | undefined) {
  if (value === undefined) delete process.env.AI_TOOL_FACADE;
  else process.env.AI_TOOL_FACADE = value;
}

afterEach(() => {
  setFlag(ORIGINAL_FLAG);
});

function toolNames(tools: Array<{ function: { name: string } }>): string[] {
  return tools.map((t) => t.function.name);
}

const PHONE_BODY: OrchestratorRequest = {
  orchestratorMode: 'phone',
  messages: [],
  callContext: { callId: 'call-1', from: '+447700900123' },
};

const STAFF_BODY: OrchestratorRequest = {
  orchestratorMode: 'staff',
  messages: [],
  staffContext: { role: 'staff', route: '/crm', userName: 'Pat', userId: 'u1' },
};

describe('facade flag default', () => {
  it('is OFF unless AI_TOOL_FACADE === "true"', () => {
    setFlag(undefined);
    assert.equal(isFacadeEnabled(), false);
    setFlag('false');
    assert.equal(isFacadeEnabled(), false);
    setFlag('1');
    assert.equal(isFacadeEnabled(), false);
    setFlag('true');
    assert.equal(isFacadeEnabled(), true);
  });
});

describe('facade schemas survive sanitizeToolsForOpenAI unchanged', () => {
  it('all 12 schemas are returned byte-identical by the sanitizer', () => {
    assert.equal(FACADE_TOOLS.length, 12);
    const sanitized = sanitizeToolsForOpenAI(FACADE_TOOLS);
    assert.equal(JSON.stringify(sanitized), JSON.stringify(FACADE_TOOLS));
  });

  it('every schema is a flat object with an operation enum inside properties', () => {
    for (const tool of FACADE_TOOLS) {
      const params = tool.function.parameters as Record<string, unknown>;
      assert.equal(params.type, 'object', tool.function.name);
      for (const banned of ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not']) {
        assert.ok(!(banned in params), `${tool.function.name} must not use top-level ${banned}`);
      }
      const properties = params.properties as Record<string, Record<string, unknown>>;
      assert.ok(properties.operation, `${tool.function.name} needs an operation property`);
      assert.ok(Array.isArray(properties.operation.enum), `${tool.function.name} operation needs an enum`);
      assert.ok(properties.payload, `${tool.function.name} needs a payload property`);
      assert.deepEqual(params.required, ['operation']);
    }
  });

  it('operation enums match FACADE_OPERATION_MAP exactly', () => {
    for (const tool of FACADE_TOOLS) {
      const name = tool.function.name;
      const properties = (tool.function.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
      assert.deepEqual(properties.operation.enum, Object.keys(FACADE_OPERATION_MAP[name]), name);
    }
  });
});

describe('every facade operation maps to an existing canonical tool', () => {
  it('all mapped canonical names exist in the flag-off tool registries', () => {
    setFlag(undefined);
    const known = new Set<string>();
    for (const mode of ['staff', 'project', 'planning', 'customer'] as const) {
      for (const name of toolNames(getToolsForMode(mode))) known.add(name);
    }
    for (const [facadeName, ops] of Object.entries(FACADE_OPERATION_MAP)) {
      for (const [op, canonical] of Object.entries(ops)) {
        assert.ok(known.has(canonical), `${facadeName}.${op} → ${canonical} has no canonical schema`);
      }
    }
  });

  it('managePlanning keeps the 17 planning operation names verbatim, 1:1', () => {
    const ops = FACADE_OPERATION_MAP.managePlanning;
    assert.deepEqual(Object.keys(ops), [...PLANNING_ACTION_NAMES]);
    for (const name of PLANNING_ACTION_NAMES) {
      assert.equal(ops[name], name);
    }
  });

  it('no canonical target is itself a facade name (no chaining)', () => {
    for (const ops of Object.values(FACADE_OPERATION_MAP)) {
      for (const canonical of Object.values(ops)) {
        assert.equal(isFacadeToolName(canonical), false, canonical);
      }
    }
  });
});

describe('expandFacadeCall', () => {
  it('merges payload fields with top-level ids into flat canonical args', () => {
    const expanded = expandFacadeCall('manageQuote', {
      operation: 'save',
      quoteId: 'Q1',
      payload: { customerId: 'C1', total: 500, items: [{ name: 'Tiles', total: 500 }] },
    });
    assert.ok(expanded);
    assert.equal(expanded.canonicalAction, 'saveQuote');
    assert.deepEqual(expanded.canonicalArgs, {
      customerId: 'C1',
      total: 500,
      items: [{ name: 'Tiles', total: 500 }],
      quoteId: 'Q1',
    });
  });

  it('top-level ids override payload values only when non-empty', () => {
    const winner = expandFacadeCall('managePricing', {
      operation: 'approve',
      quoteId: 'top-level',
      payload: { quoteId: 'payload', total: 900 },
    });
    assert.equal(winner?.canonicalArgs.quoteId, 'top-level');
    const empty = expandFacadeCall('managePricing', {
      operation: 'approve',
      quoteId: '',
      payload: { quoteId: 'payload' },
    });
    assert.equal(empty?.canonicalArgs.quoteId, 'payload');
  });

  it('works without a payload object', () => {
    const expanded = expandFacadeCall('searchRecords', { operation: 'customers', query: 'olivia' });
    assert.equal(expanded?.canonicalAction, 'searchCustomers');
    assert.deepEqual(expanded?.canonicalArgs, { query: 'olivia' });
  });

  it('returns null for unknown operations, missing operations, and non-facade names', () => {
    assert.equal(expandFacadeCall('manageQuote', { operation: 'explode' }), null);
    assert.equal(expandFacadeCall('manageQuote', {}), null);
    assert.equal(expandFacadeCall('saveQuote', { operation: 'save' }), null);
    assert.equal(expandFacadeCall('', undefined), null);
  });

  it('never forwards the operation/payload routing keys', () => {
    const expanded = expandFacadeCall('appControl', {
      operation: 'writeData',
      payload: { collection: 'customers', operation: 'update', id: 'C1', data: { name: 'New' } },
    });
    // Inner payload.operation (the writeData op) must survive; the facade routing key must not clobber it.
    assert.equal(expanded?.canonicalAction, 'writeData');
    assert.equal(expanded?.canonicalArgs.operation, 'update');
    assert.equal(expanded?.canonicalArgs.collection, 'customers');
    assert.ok(!('payload' in (expanded?.canonicalArgs ?? {})));
  });
});

describe('mode gating', () => {
  it('phone tool list is byte-identical with the flag on vs off', () => {
    setFlag(undefined);
    const off = JSON.stringify(getToolsForMode('phone', PHONE_BODY));
    setFlag('true');
    const on = JSON.stringify(getToolsForMode('phone', PHONE_BODY));
    assert.equal(on, off);
  });

  it('customer and cyrus tool lists are byte-identical with the flag on vs off', () => {
    for (const mode of ['customer', 'cyrus'] as const) {
      setFlag(undefined);
      const off = JSON.stringify(getToolsForMode(mode));
      setFlag('true');
      const on = JSON.stringify(getToolsForMode(mode));
      assert.equal(on, off, mode);
    }
  });

  it('flag off (unset or false) leaves web-staff tools exactly as today — no facade names', () => {
    setFlag(undefined);
    const unset = JSON.stringify(getToolsForMode('staff', STAFF_BODY));
    setFlag('false');
    const explicitOff = JSON.stringify(getToolsForMode('staff', STAFF_BODY));
    assert.equal(unset, explicitOff);
    const names = toolNames(getToolsForMode('staff', STAFF_BODY));
    for (const facadeName of FACADE_TOOL_NAMES) {
      assert.ok(!names.includes(facadeName), `${facadeName} must not appear with flag off`);
    }
    assert.ok(names.includes('saveQuote'));
    assert.ok(names.includes('readData'));
  });

  it('flag on gives web-staff modes exactly the facade tools (planning gated by context)', () => {
    setFlag('true');
    for (const mode of ['staff', 'project', 'foreman'] as const) {
      assert.ok(FACADE_WEB_STAFF_MODES.has(mode));
      const names = toolNames(getToolsForMode(mode));
      assert.deepEqual(names, FACADE_TOOL_NAMES.filter((n) => n !== 'managePlanning'), mode);
    }
    assert.deepEqual(toolNames(getToolsForMode('planning')), FACADE_TOOL_NAMES);
    // Staff mode WITH planning context also gets managePlanning.
    const planningBody: OrchestratorRequest = {
      ...STAFF_BODY,
      planningApplicationContext: { id: 'PA-1' },
    };
    assert.ok(toolNames(getToolsForMode('staff', planningBody)).includes('managePlanning'));
  });
});

describe('gate integrity — facade cannot bypass role or confirmation gates', () => {
  const ALL_ROLES: ServerAgentRole[] = [
    'platform_owner', 'super_admin', 'manager', 'staff', 'builder', 'recruitment', 'customer', 'agent', 'unknown',
  ];

  it('managePricing.approve expands to approveQuote and keeps the manager-only gate', () => {
    const expanded = expandFacadeCall('managePricing', { operation: 'approve', payload: { quoteId: 'Q1' } });
    assert.equal(expanded?.canonicalAction, 'approveQuote');
    const action = { action: expanded!.canonicalAction, input: {}, output: expanded!.canonicalArgs };
    assert.deepEqual(filterActionsForRole('staff', [action]), []);
    assert.deepEqual(filterActionsForRole('builder', [action]), []);
    assert.equal(filterActionsForRole('manager', [action]).length, 1);
    assert.equal(filterActionsForRole('super_admin', [action]).length, 1);
  });

  it('approveQuote and sendContract are never auto-run (client confirmation preserved)', () => {
    assert.equal(AUTO_ACTION_NAMES.has('approveQuote'), false);
    assert.equal(AUTO_ACTION_NAMES.has('sendContract'), false);
    const expanded = expandFacadeCall('manageContract', { operation: 'send', payload: { contractId: 'CT1' } });
    assert.equal(expanded?.canonicalAction, 'sendContract');
    assert.equal(AUTO_ACTION_NAMES.has(expanded!.canonicalAction), false);
  });

  it('unexpanded facade names carry no permissions and no auto-run rights for any role', () => {
    for (const facadeName of FACADE_TOOL_NAMES) {
      assert.equal(AUTO_ACTION_NAMES.has(facadeName), false, facadeName);
      for (const role of ALL_ROLES) {
        assert.equal(
          canExecuteActionForRole(role, facadeName),
          false,
          `${facadeName} must not be executable as-is for role ${role}`
        );
      }
    }
  });
});
