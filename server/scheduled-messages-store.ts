import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const FILE = join(DATA_DIR, 'scheduled-messages.json');

export type ScheduledMessageStatus = 'queued' | 'sent' | 'failed' | 'cancelled';

export type ScheduledMessage = {
  id: string;
  orgId: string;
  sendAt: string;
  channels: Array<'email' | 'whatsapp'>;
  toEmail?: string;
  toPhone?: string;
  customerId?: string;
  customerName?: string;
  templateId?: string;
  subject: string;
  body: string;
  status: ScheduledMessageStatus;
  createdBy: string;
  aim?: string;
  createdAt: string;
  sentAt?: string;
  error?: string;
  heroTitle?: string;
  ctaUrl?: string;
  ctaLabel?: string;
};

type StoreFile = { jobs: ScheduledMessage[] };

let memory: StoreFile | null = null;

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load(): StoreFile {
  if (memory) return memory;
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf-8')) as StoreFile;
      memory = { jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [] };
      return memory;
    }
  } catch {
    /* ignore */
  }
  memory = { jobs: [] };
  return memory;
}

function persist() {
  ensureDir();
  writeFileSync(FILE, JSON.stringify(load(), null, 2));
}

export function listScheduledMessages(orgId?: string, status?: ScheduledMessageStatus): ScheduledMessage[] {
  const jobs = load().jobs;
  return jobs.filter((j) => {
    if (orgId && j.orgId !== orgId) return false;
    if (status && j.status !== status) return false;
    return true;
  }).sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}

export function getScheduledMessage(id: string): ScheduledMessage | undefined {
  return load().jobs.find((j) => j.id === id);
}

export function enqueueScheduledMessage(
  input: Omit<ScheduledMessage, 'id' | 'status' | 'createdAt'> & { status?: ScheduledMessageStatus },
): ScheduledMessage {
  const store = load();
  const day = input.sendAt.slice(0, 10);
  const dup = store.jobs.find(
    (j) =>
      j.status === 'queued'
      && j.orgId === input.orgId
      && j.customerId
      && j.customerId === input.customerId
      && j.templateId
      && j.templateId === input.templateId
      && j.sendAt.startsWith(day),
  );
  if (dup) return dup;

  const job: ScheduledMessage = {
    ...input,
    id: randomUUID(),
    status: input.status || 'queued',
    createdAt: new Date().toISOString(),
  };
  store.jobs.push(job);
  persist();
  return job;
}

export function updateScheduledMessage(
  id: string,
  patch: Partial<ScheduledMessage>,
): ScheduledMessage | undefined {
  const store = load();
  const idx = store.jobs.findIndex((j) => j.id === id);
  if (idx < 0) return undefined;
  store.jobs[idx] = { ...store.jobs[idx], ...patch };
  persist();
  return store.jobs[idx];
}

export function cancelScheduledMessage(id: string): ScheduledMessage | undefined {
  return updateScheduledMessage(id, { status: 'cancelled' });
}

export function dueScheduledMessages(now = Date.now()): ScheduledMessage[] {
  return load().jobs.filter(
    (j) => j.status === 'queued' && Date.parse(j.sendAt) <= now,
  );
}
