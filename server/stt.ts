import { requireOpenAIApiKeyAsync } from './openai-connection';
import { getOrgOpenAIApiKey, listOrganizations } from './organizations';

function resolveSttOrgId(preferred?: string | null): string | null {
  if (preferred && getOrgOpenAIApiKey(preferred)) return preferred;
  for (const org of listOrganizations()) {
    if (getOrgOpenAIApiKey(org.id)) return org.id;
  }
  return preferred ?? null;
}

/** Transcribe WAV / audio bytes with Whisper using the org OpenAI key. */
export async function transcribeAudioBuffer(
  buffer: Buffer,
  filename = 'utterance.wav',
  mimeType = 'audio/wav',
  orgId?: string | null,
): Promise<string> {
  const resolvedOrg = resolveSttOrgId(orgId);
  const apiKey = await requireOpenAIApiKeyAsync(undefined, resolvedOrg);
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });
  const file = new File([buffer], filename, { type: mimeType });
  const transcript = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    language: 'en',
  });
  return String(transcript.text ?? '').trim();
}
