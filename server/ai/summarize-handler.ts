export interface SummarizeRequestBody {
  messages: Array<{ role: string; content: string; timestamp?: string }>;
  customerName?: string;
  model?: string;
  apiKey?: string;
  orgId?: string;
}

const SUMMARY_SYSTEM_PROMPT = `You are a CRM assistant for a UK bathroom and construction sales team.
Summarize the WhatsApp conversation between a customer and the Cynthia AI assistant for internal staff.

Write a concise staff-facing summary (max 200 words) with these sections as bullet points:
- Customer: who they are and contact context if known
- Intent: what they want (trade, scope, urgency)
- Key details: budget, address, timing, quotes, or project status mentioned
- Sentiment: tone and satisfaction level
- Status: where the conversation stands now
- Next steps: clear recommended actions for staff

Use plain English. Be factual — only include details present in the transcript. If something is unknown, say "Not mentioned".`;

function formatTranscript(
  messages: SummarizeRequestBody['messages'],
  customerName?: string,
): string {
  const header = customerName
    ? `Customer: ${customerName}\n\n`
    : '';
  const lines = messages.map((msg) => {
    const speaker = msg.role === 'user' ? 'Customer' : 'Cyrus';
    const time = msg.timestamp
      ? ` (${new Date(msg.timestamp).toLocaleString('en-GB')})`
      : '';
    return `${speaker}${time}: ${msg.content}`;
  });
  return header + lines.join('\n\n');
}

export async function handleSummarizeChat(
  body: SummarizeRequestBody,
): Promise<{ summary: string }> {
  const { createLLMClientForOrg, defaultChatModelForProvider } = await import('./llm-connection');
  const { resolveOrgIdFromBody } = await import('../org-context');
  const orgId = resolveOrgIdFromBody(body);

  if (!body.messages?.length) {
    throw new Error('No messages provided');
  }

  const { client: openai, provider } = await createLLMClientForOrg(orgId, '/api/ai/summarize', {
    bodyOpenAIApiKey: body.apiKey,
  });
  const model = defaultChatModelForProvider(provider, body.model ?? 'gpt-4o-mini');

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Summarize this conversation for staff:\n\n${formatTranscript(body.messages, body.customerName)}`,
      },
    ],
    temperature: 0.3,
  });

  const summary = completion.choices[0]?.message?.content?.trim() ?? '';
  if (!summary) {
    throw new Error('Empty summary returned from OpenAI');
  }

  return { summary };
}
