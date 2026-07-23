/**
 * Regression: orchestrator / Sally / phone-tool split imports remain bound.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  safeParseObject,
  buildActionsSummaryText,
  executeVisionTool,
} from './ai/orchestrator/helpers';
import {
  readDraft,
  writeDraft,
  requireTermsConfirmed,
  generateTempPassword,
  SALLY_TOOL_NAMES,
} from './sally/offer';
import { isSallyToolName } from './sally/tools';
import { isStaffPartyPhone } from './phone/tools/leads';
import { executePhoneTool } from './phone/tools/execute';
import { SALLY_RECEPTIONIST_TOOL_NAMES } from './sally-receptionist';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('remediation split-import regressions', () => {
  it('exports orchestrator helpers used by handle.ts', () => {
    assert.equal(typeof safeParseObject, 'function');
    assert.equal(typeof buildActionsSummaryText, 'function');
    assert.equal(typeof executeVisionTool, 'function');
    assert.deepEqual(safeParseObject('{"a":1}'), { a: 1 });
    assert.equal(safeParseObject('not-json').a, undefined);
  });

  it('exports Sally draft/terms helpers and SALLY_TOOL_NAMES', () => {
    assert.equal(typeof readDraft, 'function');
    assert.equal(typeof writeDraft, 'function');
    assert.equal(typeof requireTermsConfirmed, 'function');
    assert.equal(typeof generateTempPassword, 'function');
    assert.ok(SALLY_TOOL_NAMES.has('bookCallback'));
    assert.equal(isSallyToolName('bookCallback'), true);
    assert.equal(isSallyToolName('not_a_real_tool_xyz'), false);
    const pwd = generateTempPassword();
    assert.ok(pwd.length >= 8);
  });

  it('phone tools import staff helper and receptionist module path', () => {
    assert.equal(typeof isStaffPartyPhone, 'function');
    assert.equal(typeof executePhoneTool, 'function');
    assert.ok(SALLY_RECEPTIONIST_TOOL_NAMES instanceof Set);
    const executeSrc = readFileSync(join(root, 'server/phone/tools/execute.ts'), 'utf8');
    assert.match(executeSrc, /from '\.\/leads'/);
    assert.match(executeSrc, /import\('\.\.\/\.\.\/sally-receptionist'\)/);
    assert.doesNotMatch(executeSrc, /import\('\.\.\/sally-receptionist'\)/);
  });

  it('quarantine remains excluded from tsconfig and unmounted from index', () => {
    const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as {
      exclude?: string[];
    };
    assert.ok(
      (tsconfig.exclude || []).some((e) => e.includes('_quarantine')),
      'tsconfig must exclude server/_quarantine',
    );
    const indexSrc = readFileSync(join(root, 'server/index.ts'), 'utf8');
    assert.doesNotMatch(indexSrc, /_quarantine/);
    assert.doesNotMatch(indexSrc, /vapi-routes\.vps/);
    assert.doesNotMatch(indexSrc, /phone-webhook\.vps/);
  });
});
