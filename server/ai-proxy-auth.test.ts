/**
 * AI proxy authentication (migrated from frontend tests/unit/aiProxyAuth.test.ts).
 * Run: npm test  (needs --experimental-test-module-mocks for mock.module)
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const getProfileByBearer = mock.fn(async () => ({
  id: 'user-1',
  role: 'super_admin',
  org_id: 'org-1',
}));

const handleOrchestrator = mock.fn(async (_body: Record<string, unknown>) => ({
  content: 'ok',
  proposedActions: [],
  autoActions: [],
  detectedTrades: [],
}));

// Module mocks must be registered before ai-proxy is imported.
mock.module('./auth.ts', {
  namedExports: {
    isAuthEnforced: () => true,
    requireAuth: () => null,
    resolveOrgIdForRequest: () => null,
  },
});

mock.module('./account-auth.ts', {
  namedExports: { getProfileByBearer },
});

// Domain modules live under server/ai/; root paths are re-export stubs.
mock.module('./ai/openai-connection.ts', {
  namedExports: {
    OpenAIConnectionError: class OpenAIConnectionError extends Error {},
    resolveOpenAIApiKeyAsync: async () => 'test-key',
  },
});

mock.module('./ai/orchestrator-handler.ts', {
  namedExports: { handleOrchestrator },
});

const { handleAiRequest } = await import('./ai/ai-proxy.ts');

class MockRequest extends EventEmitter {
  method = 'POST';
  headers = { authorization: 'Bearer supabase-session' };
}

class MockResponse {
  statusCode = 200;
  body = '';

  setHeader() {}

  end(body = '') {
    this.body = body;
  }
}

describe('AI proxy authentication', () => {
  beforeEach(() => {
    getProfileByBearer.mock.resetCalls();
    handleOrchestrator.mock.resetCalls();
  });

  it('accepts a Supabase session and uses its profile organization', async () => {
    const req = new MockRequest();
    const res = new MockResponse();
    const response = handleAiRequest(req as never, res as never, '/api/ai/orchestrate');

    setTimeout(() => {
      req.emit('data', JSON.stringify({ messages: [] }));
      req.emit('end');
    }, 0);
    await response;

    assert.equal(res.statusCode, 200);
    assert.equal(handleOrchestrator.mock.callCount(), 1);
    const orchestratorBody = handleOrchestrator.mock.calls[0].arguments[0] as { orgId?: string };
    assert.equal(orchestratorBody.orgId, 'org-1');
  });
});
