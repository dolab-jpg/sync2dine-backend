/**
 * Platform-owner ops alert contacts — email / SMS / Trae webhook.
 * Stored as JSON so the VPS health watchdog can read it when Node is down.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const CONTACTS_FILE = join(DATA_DIR, 'ops-contacts.json');

export type OpsContacts = {
  alertEmail: string;
  alertPhone: string;
  traeWebhookUrl: string;
  updatedAt?: string;
  updatedBy?: string;
};

const DEFAULT_EMAIL = 'dolab@diamondea.co.uk';

let memory: OpsContacts | null = null;

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function fromEnv(): Partial<OpsContacts> {
  return {
    alertEmail: process.env.OPS_ALERT_EMAIL?.trim() || undefined,
    alertPhone: process.env.OPS_ALERT_PHONE?.trim() || undefined,
    traeWebhookUrl: process.env.OPS_TRAE_WEBHOOK_URL?.trim() || undefined,
  };
}

function normalize(raw: Partial<OpsContacts> | null | undefined): OpsContacts {
  const env = fromEnv();
  const email = String(raw?.alertEmail ?? env.alertEmail ?? DEFAULT_EMAIL).trim() || DEFAULT_EMAIL;
  const phone = String(raw?.alertPhone ?? env.alertPhone ?? '').trim();
  const trae = String(raw?.traeWebhookUrl ?? env.traeWebhookUrl ?? '').trim();
  return {
    alertEmail: email,
    alertPhone: phone,
    traeWebhookUrl: trae,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : undefined,
    updatedBy: typeof raw?.updatedBy === 'string' ? raw.updatedBy : undefined,
  };
}

function load(): OpsContacts {
  if (memory) return memory;
  try {
    if (existsSync(CONTACTS_FILE)) {
      const parsed = JSON.parse(readFileSync(CONTACTS_FILE, 'utf-8')) as Partial<OpsContacts>;
      memory = normalize(parsed);
      return memory;
    }
  } catch {
    /* ignore */
  }
  memory = normalize({});
  return memory;
}

function persist(next: OpsContacts) {
  ensureDir();
  memory = next;
  try {
    writeFileSync(CONTACTS_FILE, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn('[ops-contacts] persist failed:', err instanceof Error ? err.message : err);
  }
}

/** Absolute path for watchdog scripts. */
export function opsContactsFilePath(): string {
  return CONTACTS_FILE;
}

export function getOpsContacts(): OpsContacts {
  return { ...load() };
}

export function updateOpsContacts(
  patch: Partial<OpsContacts>,
  updatedBy = 'platform-owner',
): OpsContacts {
  const cur = load();
  const next = normalize({
    ...cur,
    alertEmail: patch.alertEmail !== undefined ? String(patch.alertEmail) : cur.alertEmail,
    alertPhone: patch.alertPhone !== undefined ? String(patch.alertPhone) : cur.alertPhone,
    traeWebhookUrl:
      patch.traeWebhookUrl !== undefined ? String(patch.traeWebhookUrl) : cur.traeWebhookUrl,
    updatedAt: new Date().toISOString(),
    updatedBy,
  });
  persist(next);
  return { ...next };
}
