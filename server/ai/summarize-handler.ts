export interface SummarizeRequestBody {
  messages: Array<{
    role: string;
    content: string;
    timestamp?: string;
    channel?: string;
    fromRole?: string;
  }>;
  customerName?: string;
  channel?: string;
  model?: string;
  apiKey?: string;
  orgId?: string;
}

const SUMMARY_SYSTEM_PROMPT = `You are a CRM assistant for Sync2Dine staff (UK restaurant phone + WhatsApp inbox).
Summarize the conversation between a customer and the AI assistant for internal staff.

Write a concise staff-facing summary (max 200 words) with these sections as bullet points:
- Customer: who they are and contact context if known
- Intent: what they want (demo, meeting, order, support, sales pitch, etc.)
- Key details: budget, venue, timing, packages, or project status mentioned
- Sentiment: tone and satisfaction level (or "Not available — voicemail / no human answer" when applicable)
- Status: where the conversation stands now
- Next steps: clear recommended actions for staff

Rules:
- Use plain English. Be factual — only include details present in the transcript. If something is unknown, say "Not mentioned".
- Keep brand and assistant names exact: Sync2Dine, Sally (sales phone), Judie (diner phone), Cynthia (staff inbox). NEVER invent "Cyrus" or garble Sync2Dine.
- Phone / voicemail: distinguish (a) the customer side was a voicemail greeting / answering machine from (b) whether the assistant actually left a voicemail message. If the transcript only shows "voicemail noted" or hang-up without a leave-message, say no proper voicemail was left.
- Prefer short bullets; do not invent demos, prices, or outcomes not in the transcript.`;

function assistantSpeakerLabel(msg: SummarizeRequestBody['messages'][number], threadChannel?: string): string {
  const role = String(msg.fromRole || '').toLowerCase();
  if (role === 'sally') return 'Sally';
  if (role === 'judie') return 'Judie';
  if (role === 'cynthia') return 'Cynthia';
  if (role === 'staff') return 'Staff';
  if (role === 'system') return 'System';
  const channel = String(msg.channel || threadChannel || '').toLowerCase();
  if (channel === 'phone') return 'Phone assistant';
  return 'Cynthia';
}

function formatTranscript(
  messages: SummarizeRequestBody['messages'],
  customerName?: string,
  threadChannel?: string,
): string {
  const header = [
    customerName ? `Customer: ${customerName}` : '',
    threadChannel ? `Channel: ${threadChannel}` : '',
  ].filter(Boolean).join('\n');
  const lines = messages.map((msg) => {
    const speaker = msg.role === 'user' ? 'Customer' : assistantSpeakerLabel(msg, threadChannel);
    const time = msg.timestamp
      ? ` (${new Date(msg.timestamp).toLocaleString('en-GB')})`
      : '';
    return `${speaker}${time}: ${msg.content}`;
  });
  return (header ? `${header}\n\n` : '') + lines.join('\n\n');
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
  const threadChannel = body.channel || body.messages.find((m) => m.channel)?.channel;

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Summarize this conversation for staff:\n\n${formatTranscript(body.messages, body.customerName, threadChannel)}`,
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
