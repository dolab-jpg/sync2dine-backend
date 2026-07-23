/**
 * BrainId resolution for phone packages.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrainId } from './index';

describe('resolveBrainId', () => {
  it('maps agentPersona cynthia to cynthia brain', () => {
    assert.equal(resolveBrainId({ agentPersona: 'cynthia' }), 'cynthia');
  });

  it('maps linePurpose cynthia to cynthia brain', () => {
    assert.equal(resolveBrainId({ callMeta: { linePurpose: 'cynthia' } }), 'cynthia');
  });

  it('keeps sally sales on sally', () => {
    assert.equal(
      resolveBrainId({
        agentPersona: 'sally',
        callMeta: { agentPersona: 'sally', linePurpose: 'sally' },
      }),
      'sally',
    );
  });

  it('maps lizzie alias to judie', () => {
    assert.equal(resolveBrainId({ agentPersona: 'lizzie' }), 'judie');
  });

  it('defaults to judie', () => {
    assert.equal(resolveBrainId({}), 'judie');
    assert.equal(resolveBrainId({ agentPersona: 'judie', callMeta: { linePurpose: 'aria' } }), 'judie');
  });

  it('prefers sally sales over linePurpose cynthia when persona is sally', () => {
    assert.equal(
      resolveBrainId({
        agentPersona: 'sally',
        callMeta: { linePurpose: 'cynthia' },
      }),
      'sally',
    );
  });
});
