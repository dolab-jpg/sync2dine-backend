/**
 * Sally reply-speed lock: wait / endpointing / spoken rate for sales + hiring.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SALLY_REPLY_SPEED,
  sallyStartSpeakingPlan,
  sallyStopSpeakingPlan,
  sallyVoiceSpeed,
} from './vapi-assistant.js';

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe('Sally reply speed', () => {
  it('starts speaking faster than the old 0.55s / 1.2s no-punctuation defaults', () => {
    withEnv('VAPI_SALLY_WAIT_SECONDS', undefined, () => {
      withEnv('VAPI_SALLY_EOT_WAIT_FUNCTION', undefined, () => {
        const plan = sallyStartSpeakingPlan();
        assert.equal(plan.waitSeconds, 0.38);
        assert.ok(plan.waitSeconds < 0.55);
        assert.equal(plan.transcriptionEndpointingPlan.onPunctuationSeconds, 0.25);
        assert.equal(plan.transcriptionEndpointingPlan.onNoPunctuationSeconds, 0.9);
        assert.ok(plan.transcriptionEndpointingPlan.onNoPunctuationSeconds < 1.2);
        assert.equal(plan.transcriptionEndpointingPlan.onNumberSeconds, 0.4);
        assert.equal(plan.smartEndpointingPlan.provider, 'livekit');
        assert.equal(plan.smartEndpointingPlan.waitFunction, SALLY_REPLY_SPEED.eotWaitFunction);
      });
    });
  });

  it('interrupts with a shorter backoff than the old 1.0s stop plan', () => {
    const stop = sallyStopSpeakingPlan();
    assert.equal(stop.numWords, 3);
    assert.equal(stop.voiceSeconds, 0.3);
    assert.equal(stop.backoffSeconds, 0.8);
    assert.ok(stop.backoffSeconds < 1.0);
  });

  it('speaks slightly faster than 1.0 without rushing past 1.12', () => {
    withEnv('VAPI_SALLY_VOICE_SPEED', undefined, () => {
      const speed = sallyVoiceSpeed();
      assert.equal(speed, 1.08);
      assert.ok(speed >= 1.05);
      assert.ok(speed <= 1.12);
    });
  });

  it('honours VAPI_SALLY_WAIT_SECONDS and VAPI_SALLY_VOICE_SPEED', () => {
    withEnv('VAPI_SALLY_WAIT_SECONDS', '0.4', () => {
      assert.equal(sallyStartSpeakingPlan().waitSeconds, 0.4);
    });
    withEnv('VAPI_SALLY_VOICE_SPEED', '1.1', () => {
      assert.equal(sallyVoiceSpeed(), 1.1);
    });
  });
});
