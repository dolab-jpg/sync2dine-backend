/**
 * Provider ? chat model remapping (DeepSeek v4 vs OpenAI gpt-4o*).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultChatModelForProvider } from './llm-connection';

describe('defaultChatModelForProvider', () => {
  it('maps OpenAI ids to DeepSeek v4', () => {
    assert.equal(defaultChatModelForProvider('deepseek', 'gpt-4o'), 'deepseek-v4-pro');
    assert.equal(defaultChatModelForProvider('deepseek', 'gpt-4o-mini'), 'deepseek-v4-flash');
  });

  it('maps legacy DeepSeek ids to v4', () => {
    assert.equal(defaultChatModelForProvider('deepseek', 'deepseek-reasoner'), 'deepseek-v4-pro');
    assert.equal(defaultChatModelForProvider('deepseek', 'deepseek-chat'), 'deepseek-v4-flash');
  });

  it('keeps live DeepSeek v4 ids and defaults to flash', () => {
    assert.equal(defaultChatModelForProvider('deepseek', 'deepseek-v4-pro'), 'deepseek-v4-pro');
    assert.equal(defaultChatModelForProvider('deepseek', 'deepseek-v4-flash'), 'deepseek-v4-flash');
    assert.equal(defaultChatModelForProvider('deepseek'), 'deepseek-v4-flash');
    assert.equal(defaultChatModelForProvider('deepseek', ''), 'deepseek-v4-flash');
  });

  it('maps DeepSeek ids back to OpenAI', () => {
    assert.equal(defaultChatModelForProvider('openai', 'deepseek-v4-pro'), 'gpt-4o');
    assert.equal(defaultChatModelForProvider('openai', 'deepseek-reasoner'), 'gpt-4o');
    assert.equal(defaultChatModelForProvider('openai', 'deepseek-v4-flash'), 'gpt-4o-mini');
    assert.equal(defaultChatModelForProvider('openai', 'deepseek-chat'), 'gpt-4o-mini');
  });

  it('keeps OpenAI ids when provider is OpenAI', () => {
    assert.equal(defaultChatModelForProvider('openai', 'gpt-4o'), 'gpt-4o');
    assert.equal(defaultChatModelForProvider('openai', 'gpt-4o-mini'), 'gpt-4o-mini');
    assert.equal(defaultChatModelForProvider('openai'), 'gpt-4o-mini');
  });
});
