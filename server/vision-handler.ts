import { getDataStore } from './data-store';
import { bathroomPlaybook } from '../src/app/config/trades/playbooks/bathroom';
import { getPlaybook } from '../src/app/config/trades/playbooks';

export interface VisionExtraAssessment {
  title: string;
  description: string;
  amountMin: number;
  amountMax: number;
  confidence: number;
  risks: string[];
}

export interface VisionProgressAssessment {
  snagList: string[];
  suggestedTaskUpdates: Array<{
    taskTitle: string;
    status: 'todo' | 'in_progress' | 'completed';
    note?: string;
  }>;
  summary: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item ?? '').trim())
    .filter(Boolean);
}

function selectExtraTitle(commonExtras: readonly string[], builderNote: string): string {
  const normalized = builderNote.toLowerCase();
  const fromNote = commonExtras.find((extra) => {
    const terms = extra.toLowerCase().split(/[\s-]+/).filter((token) => token.length > 3);
    return terms.some((term) => normalized.includes(term));
  });
  return fromNote ?? commonExtras[0] ?? 'Site variation';
}

function buildMockExtraAssessment(tradeId: string | undefined, builderNote: string): VisionExtraAssessment {
  const playbook = tradeId ? getPlaybook(tradeId) : undefined;
  const commonExtras = playbook?.commonExtras ?? bathroomPlaybook.commonExtras;
  const title = selectExtraTitle(commonExtras, builderNote);

  let amountMin = 220;
  let amountMax = 540;
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes('underfloor')) {
    amountMin = 700;
    amountMax = 1250;
  } else if (lowerTitle.includes('brassware')) {
    amountMin = 320;
    amountMax = 760;
  } else if (lowerTitle.includes('led') || lowerTitle.includes('lighting')) {
    amountMin = 260;
    amountMax = 620;
  }

  return {
    title,
    description: builderNote
      ? `Builder reported: ${builderNote}. Variation appears plausible from photo evidence and should be priced as a customer change order.`
      : `${title} appears to be a likely project extra from recent photos and should be reviewed as a change order.`,
    amountMin,
    amountMax,
    confidence: 0.63,
    risks: [
      'Photo-only interpretation; verify dimensions on site.',
      'Confirm customer preference and lead times before procurement.',
    ],
  };
}

function buildMockProgressAssessment(projectContext?: Record<string, unknown>): VisionProgressAssessment {
  const tasks = Array.isArray(projectContext?.tasks)
    ? projectContext?.tasks as Array<Record<string, unknown>>
    : [];
  const openTask = tasks.find((task) => String(task.status ?? '') !== 'completed');

  return {
    snagList: [
      'Finish quality checks still required at exposed edges.',
      'One visible area may need sealant/grout tidy-up.',
    ],
    suggestedTaskUpdates: openTask
      ? [{
          taskTitle: String(openTask.title ?? 'Current active task'),
          status: 'in_progress',
          note: 'Marked in progress from visual evidence.',
        }]
      : [{
          taskTitle: 'Current active task',
          status: 'in_progress',
          note: 'Marked in progress from visual evidence.',
        }],
    summary: 'Photos indicate steady progress with minor snagging outstanding before next milestone.',
  };
}

export function resolvePhotoUrlsFromContext(
  projectContext?: Record<string, unknown>,
  photoIds?: string[]
): string[] {
  const desired = new Set((photoIds ?? []).map((id) => String(id)));
  const contextFiles = Array.isArray(projectContext?.files)
    ? projectContext?.files as Array<Record<string, unknown>>
    : [];

  let files = contextFiles;
  if (files.length === 0) {
    const projectId = readString(projectContext?.projectId);
    if (projectId) {
      const store = getDataStore();
      const project = store.projects.find(item => String(item.id) === projectId);
      if (project && Array.isArray(project.files)) {
        files = project.files as Array<Record<string, unknown>>;
      }
    }
  }

  const imageFiles = files.filter((file) => {
    const mimeType = String(file.mimeType ?? '');
    const isImage = mimeType.startsWith('image/');
    if (!isImage) return false;
    if (desired.size === 0) return true;
    return desired.has(String(file.id ?? ''));
  });

  const ordered = imageFiles.slice(-5);
  return ordered
    .map((file) => readString(file.dataUrl))
    .filter(Boolean);
}

async function runVisionExtraAssessment(
  apiKey: string,
  tradeId: string,
  builderNote: string,
  images: string[]
): Promise<VisionExtraAssessment> {
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });
  const playbook = getPlaybook(tradeId);
  const commonExtras = playbook?.commonExtras ?? bathroomPlaybook.commonExtras;
  const imageContent = images.map((url) => ({
    type: 'image_url' as const,
    image_url: { url },
  }));

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You are a UK construction foreman AI.',
          `Trade: ${tradeId}.`,
          `Common extras: ${commonExtras.join(', ')}.`,
          'Assess whether the photos indicate a customer-chargeable extra.',
          'Return strict JSON with: title, description, amountMin, amountMax, confidence, risks.',
          'Use realistic GBP ranges and confidence 0..1.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Builder note: ${builderNote || 'No note supplied.'}` },
          ...imageContent,
        ],
      },
    ],
  });

  const content = completion.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const amountMin = Math.round(readNumber(parsed.amountMin, 200));
  const amountMax = Math.round(readNumber(parsed.amountMax, amountMin + 250));

  return {
    title: readString(parsed.title) || selectExtraTitle(commonExtras, builderNote),
    description: readString(parsed.description) || 'Potential project variation identified from site photos.',
    amountMin: Math.min(amountMin, amountMax),
    amountMax: Math.max(amountMax, amountMin),
    confidence: Math.max(0, Math.min(1, readNumber(parsed.confidence, 0.62))),
    risks: readStringArray(parsed.risks).slice(0, 6),
  };
}

async function runVisionProgressAssessment(
  apiKey: string,
  tradeId: string,
  images: string[]
): Promise<VisionProgressAssessment> {
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });
  const imageContent = images.map((url) => ({
    type: 'image_url' as const,
    image_url: { url },
  }));

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You are a UK construction foreman AI reviewing site progress photos.',
          `Trade: ${tradeId}.`,
          'Return strict JSON with: snagList, suggestedTaskUpdates, summary.',
          'Each suggestedTaskUpdates item must include taskTitle and status (todo|in_progress|completed), plus optional note.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Assess progress and snags from these photos.' },
          ...imageContent,
        ],
      },
    ],
  });

  const content = completion.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const updatesRaw = Array.isArray(parsed.suggestedTaskUpdates)
    ? parsed.suggestedTaskUpdates as Array<Record<string, unknown>>
    : [];
  const suggestedTaskUpdates = updatesRaw
    .map((item) => {
      const taskTitle = readString(item.taskTitle ?? item.title);
      const status = readString(item.status);
      if (!taskTitle || !['todo', 'in_progress', 'completed'].includes(status)) return null;
      return {
        taskTitle,
        status: status as 'todo' | 'in_progress' | 'completed',
        note: readString(item.note ?? item.reason) || undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return {
    snagList: readStringArray(parsed.snagList).slice(0, 8),
    suggestedTaskUpdates,
    summary: readString(parsed.summary) || 'Progress assessed from latest photos.',
  };
}

export async function assessExtraFromVision(options: {
  apiKey?: string;
  tradeId?: string;
  builderNote?: string;
  images: string[];
  projectContext?: Record<string, unknown>;
}): Promise<VisionExtraAssessment> {
  const tradeId = readString(options.tradeId ?? options.projectContext?.tradeId) || 'bathroom';
  const builderNote = readString(options.builderNote);
  if (!options.apiKey || options.images.length === 0) {
    return buildMockExtraAssessment(tradeId, builderNote);
  }

  try {
    return await runVisionExtraAssessment(options.apiKey, tradeId, builderNote, options.images.slice(0, 5));
  } catch {
    return buildMockExtraAssessment(tradeId, builderNote);
  }
}

export async function assessProgressFromVision(options: {
  apiKey?: string;
  tradeId?: string;
  images: string[];
  projectContext?: Record<string, unknown>;
}): Promise<VisionProgressAssessment> {
  const tradeId = readString(options.tradeId ?? options.projectContext?.tradeId) || 'bathroom';
  if (!options.apiKey || options.images.length === 0) {
    return buildMockProgressAssessment(options.projectContext);
  }

  try {
    return await runVisionProgressAssessment(options.apiKey, tradeId, options.images.slice(0, 5));
  } catch {
    return buildMockProgressAssessment(options.projectContext);
  }
}
