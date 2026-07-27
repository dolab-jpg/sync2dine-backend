import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readyByClockSpoken } from './spoken-ready-time';

describe('readyByClockSpoken', () => {
  it('rounds up to quarter past', () => {
    // 14:13 London (BST)
    const now = Date.parse('2026-07-27T13:13:00.000Z');
    assert.equal(readyByClockSpoken(0, now), 'quarter past two');
  });

  it('rounds 3:16 up to half past', () => {
    const now = Date.parse('2026-07-27T14:16:00.000Z'); // BST 15:16
    assert.equal(readyByClockSpoken(0, now), 'half past three');
  });

  it('uses quarter to for :45', () => {
    const now = Date.parse('2026-07-27T14:40:00.000Z'); // BST 15:40
    assert.equal(readyByClockSpoken(0, now), 'quarter to four');
  });

  it('keeps o\'clock on the hour', () => {
    const now = Date.parse('2026-07-27T14:00:00.000Z'); // BST 15:00
    assert.equal(readyByClockSpoken(0, now), "three o'clock");
  });
});
