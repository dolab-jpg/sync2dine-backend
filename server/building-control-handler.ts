import { searchBuildingRegs } from './building-control-kb';

interface BCMessage {
  role: string;
  content: string;
}

export interface BuildingControlRequest {
  apiKey?: string;
  model?: string;
  messages: BCMessage[];
  tradeId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  sourceEmail?: string | null;
  images?: string[];
  userRole?: string;
}

export interface BCCitation {
  chunkId: string;
  docTitle: string;
  section: string;
  versionDate: string;
  sourceUrl: string;
}

export interface BuildingControlResult {
  content: string;
  citations: BCCitation[];
  complianceActions: string[];
  draftEmailReply?: string;
  photoAnalysis?: string;
}

const BC_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'searchBuildingRegs',
      description: 'Search UK Approved Documents knowledge base for relevant regulatory guidance',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query describing the building control question' },
          tradeId: { type: 'string', description: 'Optional trade filter' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'proposeComplianceActions',
      description: 'List documents or actions the builder/staff should provide to building control',
      parameters: {
        type: 'object',
        properties: {
          actions: { type: 'array', items: { type: 'string' } },
        },
        required: ['actions'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'citeSource',
      description: 'Attach structured citations from retrieved chunks to the response',
      parameters: {
        type: 'object',
        properties: {
          citations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                chunkId: { type: 'string' },
                docTitle: { type: 'string' },
                section: { type: 'string' },
                versionDate: { type: 'string' },
                sourceUrl: { type: 'string' },
              },
              required: ['chunkId', 'docTitle', 'section'],
            },
          },
        },
        required: ['citations'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draftBcEmailReply',
      description: 'Draft a professional reply to a building control officer email',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['body'],
      },
    },
  },
];

function buildBCSystemPrompt(body: BuildingControlRequest): string {
  const tradeLine = body.tradeId ? `Trade context: ${body.tradeId}` : 'Trade: not specified';
  const projectLine = body.projectName
    ? `Project: ${body.projectName} (${body.projectId ?? 'unknown id'})`
    : 'Project: none linked';
  const emailLine = body.sourceEmail
    ? `\n\nBuilding control email pasted by user:\n${body.sourceEmail}`
    : '';

  return `You are the TradePro Building Control Agent — a UK construction compliance assistant for builders and office staff.

${tradeLine}
${projectLine}
User role: ${body.userRole ?? 'staff'}
${emailLine}

RULES:
- You assist with UK Building Regulations and Approved Documents only.
- ALWAYS use searchBuildingRegs before answering regulatory questions.
- ONLY cite sources returned by searchBuildingRegs — never invent regulation references.
- Use citeSource to attach citations with document title, section, and version date.
- Use proposeComplianceActions when building control requests documents or evidence.
- Use draftBcEmailReply when the user needs a reply to a BC officer email.
- State clearly when local authority interpretation may vary.
- You do NOT replace a building control officer — include this disclaimer when giving compliance advice.
- If photos were provided, describe visible conditions separately from regulatory guidance.
- Use UK English. Be practical and concise for site staff.`;
}

function executeBCTool(
  name: string,
  args: Record<string, unknown>,
  tradeId?: string | null
): Record<string, unknown> {
  if (name === 'searchBuildingRegs') {
    const query = String(args.query ?? '');
    const filterTrade = String(args.tradeId ?? tradeId ?? '') || undefined;
    const results = searchBuildingRegs(query, { tradeId: filterTrade, limit: 8 });
    return {
      count: results.length,
      chunks: results.map((c) => ({
        chunkId: c.id,
        docTitle: c.docTitle,
        shortTitle: c.shortTitle,
        section: c.section,
        text: c.text,
        versionDate: c.versionDate,
        sourceUrl: c.sourceUrl,
      })),
    };
  }

  if (name === 'proposeComplianceActions') {
    const actions = Array.isArray(args.actions) ? args.actions.map(String) : [];
    return { actions };
  }

  if (name === 'citeSource') {
    const citations = Array.isArray(args.citations) ? args.citations : [];
    return { citations };
  }

  if (name === 'draftBcEmailReply') {
    return {
      subject: String(args.subject ?? 'Re: Building control enquiry'),
      body: String(args.body ?? ''),
    };
  }

  return {};
}

function buildMockResult(body: BuildingControlRequest): BuildingControlResult {
  const lastMsg = body.messages[body.messages.length - 1]?.content ?? '';
  const results = searchBuildingRegs(lastMsg, { tradeId: body.tradeId ?? undefined, limit: 4 });
  const citations: BCCitation[] = results.map((c) => ({
    chunkId: c.id,
    docTitle: c.docTitle,
    section: c.section,
    versionDate: c.versionDate,
    sourceUrl: c.sourceUrl,
  }));

  const actions = [
    'Confirm which Approved Document version your local authority accepts',
    'Gather relevant certificates (electrical, ventilation, waterproofing)',
    'Photograph completed work before covering up',
  ];

  let content = `Building Control Agent (mock mode): Based on your question, I found ${results.length} relevant regulation section(s).\n\n`;
  for (const c of results.slice(0, 2)) {
    content += `**${c.docTitle}** (${c.section}, v${c.versionDate}): ${c.text}\n\n`;
  }
  content += '\n*This is guidance only — confirm with your building control officer.*';

  return {
    content,
    citations,
    complianceActions: actions,
    draftEmailReply: body.sourceEmail
      ? `Dear Building Control,\n\nThank you for your email. We are preparing the requested documentation and will respond shortly.\n\nKind regards`
      : undefined,
  };
}

async function analyzePhotos(
  orgId: string | null,
  apiKey: string,
  images: string[],
  tradeId?: string | null
): Promise<string> {
  const { createOpenAIClientForOrg } = await import('./openai-connection');
  const openai = await createOpenAIClientForOrg(orgId, '/api/ai/building-control/photos', apiKey);
  const imageContent = images.map((img) => ({
    type: 'image_url' as const,
    image_url: { url: img },
  }));

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: 'Describe what is visible in these UK construction site photos relevant to building control (ventilation, drainage, electrical zones, waterproofing, structure). Be factual. Flag anything unclear.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Trade context: ${tradeId ?? 'general renovation'}. Describe visible compliance-relevant features.` },
          ...imageContent,
        ],
      },
    ],
    max_tokens: 500,
  });

  return completion.choices[0]?.message?.content ?? '';
}

export async function handleBuildingControl(body: BuildingControlRequest): Promise<BuildingControlResult> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const { resolveOpenAIApiKey, createOpenAIClientForOrg } = await import('./openai-connection');
  const { resolveOrgIdFromBody } = await import('./org-context');
  const orgId = resolveOrgIdFromBody(body as { orgId?: string });
  const apiKey = resolveOpenAIApiKey(body.apiKey, orgId);

  if (!apiKey) {
    return buildMockResult(body);
  }

  const openai = await createOpenAIClientForOrg(orgId, '/api/ai/building-control', body.apiKey);

  let photoAnalysis: string | undefined;
  if (body.images?.length) {
    try {
      photoAnalysis = await analyzePhotos(orgId, apiKey, body.images.slice(0, 3), body.tradeId);
    } catch {
      photoAnalysis = 'Photo analysis unavailable.';
    }
  }

  const systemPrompt = buildBCSystemPrompt(body);
  const userMessages = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' as const : m.role === 'system' ? 'system' as const : 'user' as const,
    content: m.content,
  }));

  if (photoAnalysis) {
    userMessages.push({
      role: 'user',
      content: `[Photo analysis]\n${photoAnalysis}`,
    });
  }

  const completion = await openai.chat.completions.create({
    model: body.model ?? 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      ...userMessages,
    ],
    tools: BC_TOOLS,
    tool_choice: 'auto',
    max_tokens: 1200,
  });

  const choice = completion.choices[0]?.message;
  const citations: BCCitation[] = [];
  let complianceActions: string[] = [];
  let draftEmailReply: string | undefined;

  if (choice?.tool_calls?.length) {
    const toolMessages = [];
    for (const call of choice.tool_calls) {
      if (call.type !== 'function') continue;
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      const output = executeBCTool(call.function.name, args, body.tradeId);

      if (call.function.name === 'citeSource' && Array.isArray(output.citations)) {
        for (const c of output.citations as BCCitation[]) {
          citations.push(c);
        }
      }
      if (call.function.name === 'proposeComplianceActions' && Array.isArray(output.actions)) {
        complianceActions = output.actions as string[];
      }
      if (call.function.name === 'draftBcEmailReply') {
        draftEmailReply = String(output.body ?? '');
      }
      if (call.function.name === 'searchBuildingRegs' && Array.isArray(output.chunks)) {
        for (const c of output.chunks as Array<Record<string, string>>) {
          if (!citations.some((existing) => existing.chunkId === c.chunkId)) {
            citations.push({
              chunkId: c.chunkId,
              docTitle: c.docTitle,
              section: c.section,
              versionDate: c.versionDate,
              sourceUrl: c.sourceUrl,
            });
          }
        }
      }

      toolMessages.push({
        role: 'tool' as const,
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }

    const secondPass = await openai.chat.completions.create({
      model: body.model ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...userMessages,
        { role: 'assistant', content: choice.content ?? '', tool_calls: choice.tool_calls },
        ...toolMessages,
      ],
      max_tokens: 1200,
    });

    const content = secondPass.choices[0]?.message?.content ?? choice.content ?? '';
    return { content, citations, complianceActions, draftEmailReply, photoAnalysis };
  }

  return {
    content: choice?.content ?? 'How can I help with your building control question?',
    citations,
    complianceActions,
    draftEmailReply,
    photoAnalysis,
  };
}
