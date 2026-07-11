import { randomUUID } from 'crypto';
import { simpleParser, type Attachment } from 'mailparser';
import type { CachedEmailAttachment } from './types';
import { saveAttachment } from './mailbox-store';

export interface ParsedEmail {
  messageId: string;
  threadId: string;
  from: { name?: string; address: string };
  to: { name?: string; address: string }[];
  cc: { name?: string; address: string }[];
  subject: string;
  date: Date;
  textBody?: string;
  htmlBody?: string;
  snippet: string;
  attachments: ParsedAttachment[];
  inReplyTo?: string;
  references?: string[];
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  content?: Buffer;
}

function generateFallbackId(): string {
  return `<generated-${randomUUID()}@tradepro.local>`;
}

function threadIdFromHeaders(inReplyTo?: string, references?: string[], messageId?: string): string {
  if (inReplyTo) return inReplyTo.replace(/[<>]/g, '');
  if (references?.length) return references[0].replace(/[<>]/g, '');
  return (messageId ?? generateFallbackId()).replace(/[<>]/g, '');
}

async function extractAttachments(attachments: Attachment[] | undefined): Promise<ParsedAttachment[]> {
  if (!attachments?.length) return [];
  return attachments.map(a => ({
    filename: a.filename || 'attachment',
    mimeType: a.contentType || 'application/octet-stream',
    size: a.size ?? 0,
    contentId: a.contentId,
    content: a.content,
  }));
}

export async function parseMime(source: Buffer): Promise<ParsedEmail> {
  const parsed = await simpleParser(source);
  const fromVal = parsed.from?.value?.[0];
  const messageId = parsed.messageId ?? generateFallbackId();
  const refs = parsed.references
    ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
    : undefined;

  return {
    messageId,
    threadId: threadIdFromHeaders(parsed.inReplyTo, refs, messageId),
    from: {
      name: fromVal?.name,
      address: fromVal?.address ?? '',
    },
    to: parsed.to?.value?.map(v => ({ name: v.name, address: v.address })) ?? [],
    cc: parsed.cc?.value?.map(v => ({ name: v.name, address: v.address })) ?? [],
    subject: parsed.subject ?? '(no subject)',
    date: parsed.date ?? new Date(),
    textBody: parsed.text,
    htmlBody: typeof parsed.html === 'string' ? parsed.html : undefined,
    snippet: (parsed.text ?? '').slice(0, 200),
    attachments: await extractAttachments(parsed.attachments),
    inReplyTo: parsed.inReplyTo,
    references: refs,
  };
}

export function persistAttachments(
  messageCacheId: string,
  attachments: ParsedAttachment[]
): CachedEmailAttachment[] {
  const saved: CachedEmailAttachment[] = [];
  for (const att of attachments) {
    if (!att.content || att.size > 25 * 1024 * 1024) continue;
    const row: CachedEmailAttachment = {
      id: randomUUID(),
      messageCacheId,
      filename: att.filename,
      mimeType: att.mimeType,
      sizeBytes: att.size,
      contentId: att.contentId,
      storagePath: `inline:${messageCacheId}:${att.filename}`,
    };
    saveAttachment(row);
    saved.push(row);
  }
  return saved;
}

export function groupThreads(
  messages: Array<{
    threadId: string;
    subject: string;
    fromAddr: string;
    snippet: string;
    receivedAt: string;
  }>
) {
  const map = new Map<string, typeof messages>();
  for (const m of messages) {
    const list = map.get(m.threadId) ?? [];
    list.push(m);
    map.set(m.threadId, list);
  }
  return Array.from(map.entries()).map(([threadId, msgs]) => {
    const sorted = [...msgs].sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
    );
    const latest = sorted[0];
    const participants = [...new Set(msgs.map(m => m.fromAddr))];
    return {
      threadId,
      subject: latest.subject,
      participants,
      lastMessageAt: latest.receivedAt,
      snippet: latest.snippet,
      unread: false,
      messageCount: msgs.length,
    };
  }).sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  );
}
