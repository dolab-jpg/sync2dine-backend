/**
 * Sally Web channel adapter ù anonymous marketing chat on sync2dine.io.
 * Uses Sally sales BI (prompts + offer tools). Does NOT use Cynthia staff orchestrator.
 */
import type { OrchestratorMessage } from '../ai/orchestrator-types';
import { OpenAIConnectionError, mapOpenAIError } from '../ai/openai-connection';
import { createLLMClientForOrg, defaultChatModelForProvider } from '../ai/llm-connection';
import { getHomeOrgId } from '../home-org';
import {
  getSallyDraftForSession,
  getSallyTermsForSession,
  resolveSallySessionKey,
} from './offer';
import { buildSallyWebPrompt } from './prompts';
import { getSallyWebOrchestratorTools } from './tools';
import { executeSallyTool } from './execute';

const MAX_TOOL_ROUNDS = 4;

export type SallyWebChatInput = {
  orgId?: string | null;
  sessionId: string;
  text: string;
  page?: string;
  visitorName?: string;
  messages: OrchestratorMessage[];
  requestId?: string;
};

export type SallyWebChatResult = {
  reply: string;
  sessionKey: string;
  toolsUsed: string[];
  model: string;
  requestId: string;
};

function logSallyWeb(event: string, fields: Record<string, unknown>) {
  // Safe diagnostics ù no secrets, no full message bodies.
  console.info(JSON.stringify({ component: 'sally-web', event, ...fields }));
}

function asToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

/**
 * Run one Sally Web turn with Sync2Dine offer knowledge + web-safe tools.
 */
export async function runSallyWebChat(input: SallyWebChatInput): Promise<SallyWebChatResult> {
  const requestId = input.requestId || `sw_${Date.now().toString(36)}`;
  const orgId = (input.orgId || getHomeOrgId() || '').trim() || null;
  const sessionKey = resolveSallySessionKey({ webSessionId: input.sessionId });
  const draft = getSallyDraftForSession(sessionKey);
  const terms = getSallyTermsForSession(sessionKey);
  const systemPrompt = buildSallyWebPrompt({
    page: input.page,
    draft,
    terms,
  });
  const tools = getSallyWebOrchestratorTools();
  const toolsUsed: string[] = [];

  const started = Date.now();
  logSallyWeb('start', {
    requestId,
    orgId: orgId || null,
    sessionIdPrefix: String(input.sessionId || '').slice(0, 12),
    page: String(input.page || '/').slice(0, 80),
    messageCount: input.messages.length,
    toolCount: tools.length,
    hasDraft: Boolean(draft && Object.keys(draft).length),
    hasTerms: Boolean(terms),
  });

  try {
    const { client, provider } = await createLLMClientForOrg(
      orgId,
      '/api/sally/web',
    );
    const model = defaultChatModelForProvider(provider);

    const chatMessages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
      ...input.messages.map((m) => ({
        role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
        content: m.content,
      })),
    ];

    let finalContent: string | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await (client as unknown as {
        chat: {
          completions: {
            create: (args: Record<string, unknown>) => Promise<{
              choices: Array<{
                message?: {
                  content?: string | null;
                  tool_calls?: Array<{
                    id: string;
                    type: string;
                    function: { name: string; arguments: string };
                  }>;
                };
              }>;
            }>;
          };
        };
      }).chat.completions.create({
        model,
        messages: chatMessages,
        tools,
        tool_choice: 'auto',
        max_tokens: 900,
      });
      const choice = response.choices[0]?.message;
      const toolCalls = choice?.tool_calls ?? [];

      if (!toolCalls.length) {
        finalContent = choice?.content ?? null;
        break;
      }

      chatMessages.push({
        role: 'assistant',
        content: choice?.content ?? '',
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        if (call.type !== 'function') continue;
        const name = call.function.name;
        const args = asToolArgs(call.function.arguments);
        toolsUsed.push(name);
        let output: Record<string, unknown>;
        try {
          output = await executeSallyTool(name, args, {
            sessionKey,
            partyPhone: '',
          });
        } catch (err) {
          output = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        chatMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(output).slice(0, 6000),
        });
      }
    }

    const reply = String(finalContent || '').trim()
      || 'I can help with Sync2Dine pricing and signup ù ask about Atmosphere, Judie, or Complete, or call 020 3745 3233.';

    logSallyWeb('ok', {
      requestId,
      ms: Date.now() - started,
      model,
      toolsUsed,
      replyChars: reply.length,
    });

    return { reply, sessionKey, toolsUsed, model, requestId };
  } catch (err) {
    const mapped = mapOpenAIError(err);
    logSallyWeb('error', {
      requestId,
      ms: Date.now() - started,
      code: mapped instanceof OpenAIConnectionError ? mapped.code : 'error',
      name: mapped.name,
      message: mapped.message.slice(0, 240),
    });
    throw mapped;
  }
}
