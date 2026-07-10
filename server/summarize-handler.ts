export interface SummarizeRequestBody {
  messages: Array<{ role: string; content: string; timestamp?: string }>;
  customerName?: string;
  model?: string;
  apiKey?: string;
  orgId?: string;
}

const SUMMARY_SYSTEM_PROMPT = `You are a CRM assistant for a UK bathroom and construction sales team.
Summarize the WhatsApp conversation between a customer and the Cyrus AI assistant for internal staff.

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
  const { resolveOpenAIApiKey, createOpenAIClientForOrg } = await import('./openai-connection');
  const { resolveOrgIdFromBody } = await import('./org-context');
  const orgId = resolveOrgIdFromBody(body);
  const apiKey = resolveOpenAIApiKey(body.apiKey, orgId);

  if (!body.messages?.length) {
    throw new Error('No messages provided');
  }

  if (!apiKey) {
    const customer = body.customerName ?? 'the customer';
    const messageCount = body.messages.length;
    return {
      summary: `Mock summary (${messageCount} messages with ${customer}):\n`
        + '- Customer: Details from transcript (mock mode)\n'
        + '- Intent: Review conversation in Cyrus threads\n'
        + '- Status: Configure OpenAI in Integrations Hub for AI-generated summaries\n'
        + '- Next steps: Set OPENAI_API_KEY and refresh this summary',
    };
  }

  const openai = await createOpenAIClientForOrg(orgId, '/api/ai/summarize', body.apiKey);

  const completion = await openai.chat.completions.create({
    model: body.model ?? 'gpt-4o-mini',
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
