export interface CategorizeRequest {
  transaction: {
    id: string;
    direction: 'in' | 'out';
    amount: number;
    description: string;
    category?: string;
  };
  context?: {
    projects?: Array<{ id: string; projectName: string; customerName: string; customerId: string }>;
    customers?: Array<{ id: string; name: string }>;
  };
  apiKey?: string;
  orgId?: string;
}

export interface CategorizeResponse {
  category: string;
  reason: string;
  suggestedMatch?: {
    projectId?: string;
    customerId?: string;
    invoiceId?: string;
    stageId?: string;
  };
}

const INCOME = ['deposit', 'stage-payment', 'final-payment', 'refund-received', 'other-income'];
const EXPENSE = ['materials', 'subcontractor', 'wages', 'tools', 'fuel', 'overheads', 'running-costs', 'tax', 'other'];

function mockCategorize(body: CategorizeRequest): CategorizeResponse {
  const { transaction, context } = body;
  const desc = transaction.description.toUpperCase();
  const matchProject = context?.projects?.find(
    (p) => desc.includes(p.customerName.toUpperCase()) || desc.includes(p.projectName.toUpperCase())
  );

  if (transaction.direction === 'in') {
    return {
      category: matchProject ? 'stage-payment' : 'other-income',
      reason: matchProject
        ? `Payment from ${matchProject.customerName} likely for ${matchProject.projectName}.`
        : 'Review incoming payment and match to CRM customer/project.',
      suggestedMatch: matchProject
        ? { projectId: matchProject.id, customerId: matchProject.customerId }
        : undefined,
    };
  }

  if (desc.includes('TILE') || desc.includes('SCREWFIX') || desc.includes('TRAVIS')) {
    return { category: 'materials', reason: 'Supplier suggests materials cost.' };
  }
  if (desc.includes('BUILDER') || desc.includes('SUB')) {
    return { category: 'subcontractor', reason: 'Subcontractor or builder payment.' };
  }
  if (desc.includes('FUEL') || desc.includes('SHELL') || desc.includes('BP ')) {
    return { category: 'fuel', reason: 'Fuel or vehicle expense.' };
  }
  if (desc.includes('HMRC') || desc.includes('TAX')) {
    return { category: 'tax', reason: 'Tax or HMRC payment.' };
  }
  return { category: 'other', reason: 'Assign category manually if unsure.' };
}

export async function handleCategorizeTransaction(body: CategorizeRequest): Promise<CategorizeResponse> {
  const { resolveOpenAIApiKey, createOpenAIClientForOrg } = await import('./openai-connection');
  const { resolveOrgIdFromBody } = await import('../org-context');
  const orgId = resolveOrgIdFromBody(body);
  const apiKey = resolveOpenAIApiKey(body.apiKey, orgId);
  if (!apiKey) return mockCategorize(body);

  const allowed = body.transaction.direction === 'in' ? INCOME : EXPENSE;
  const projectList = (body.context?.projects ?? [])
    .slice(0, 20)
    .map((p) => `- ${p.id}: ${p.projectName} (${p.customerName})`)
    .join('\n');

  try {
    const openai = await createOpenAIClientForOrg(orgId, '/api/ai/categorize-transaction', body.apiKey);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You are a UK construction company accountant.',
            'Categorise bank transactions for job costing and P&L.',
            `Income categories: ${INCOME.join(', ')}.`,
            `Expense categories: ${EXPENSE.join(', ')}.`,
            'Return JSON: category, reason (one sentence), suggestedMatch optional with projectId, customerId.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Transaction: ${body.transaction.direction === 'in' ? 'IN' : 'OUT'} £${body.transaction.amount.toFixed(2)} — ${body.transaction.description}`,
            projectList ? `Active projects:\n${projectList}` : '',
            'What is this for?',
          ].filter(Boolean).join('\n\n'),
        },
      ],
    });
    const content = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content) as CategorizeResponse;
    if (!allowed.includes(parsed.category) && parsed.category !== 'uncategorised') {
      return mockCategorize(body);
    }
    return parsed;
  } catch {
    return mockCategorize(body);
  }
}
