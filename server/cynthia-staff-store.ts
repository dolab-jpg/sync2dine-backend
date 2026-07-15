/**
 * Staff Cynthia inbox — messages & rich action cards pushed from phone AI / orchestrator.
 * Persisted in the data store under sessions keyed by staff user.
 */

import { getDataStore, syncData } from './data-store';

export type CynthiaCardAction = {
  label: string;
  kind: 'call' | 'email' | 'open' | 'navigate';
  value: string;
};

export type CynthiaStaffCard = {
  id: string;
  title: string;
  customerName?: string;
  phone?: string;
  address?: string;
  amount?: number;
  currency?: string;
  summary?: string;
  notes?: string;
  quoteId?: string;
  projectId?: string;
  customerId?: string;
  pdfDataUrl?: string;
  pdfFilename?: string;
  reportMarkdown?: string;
  actions?: CynthiaCardAction[];
  source?: 'phone' | 'cynthia' | 'share' | 'voice' | 'system';
  createdAt: string;
};

export type CynthiaStaffMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'card';
  content: string;
  card?: CynthiaStaffCard;
  artifact?: {
    type: 'pdf' | 'report';
    title: string;
    dataUrl?: string;
    filename?: string;
    markdown?: string;
  };
  timestamp: string;
  source?: string;
};

export type CynthiaStaffThread = {
  userId: string;
  orgId: string;
  messages: CynthiaStaffMessage[];
  updatedAt: string;
};

const KIND = 'cynthia_staff_thread';

function threadKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

function asThreads(): CynthiaStaffThread[] {
  const store = getDataStore();
  const sessions = Array.isArray(store.sessions) ? store.sessions : [];
  return sessions
    .filter((s) => s && typeof s === 'object' && (s as { kind?: string }).kind === KIND)
    .map((s) => s as unknown as CynthiaStaffThread & { kind: string });
}

function persistThread(thread: CynthiaStaffThread): void {
  const store = getDataStore();
  const sessions = Array.isArray(store.sessions) ? [...store.sessions] : [];
  const key = threadKey(thread.orgId, thread.userId);
  const idx = sessions.findIndex(
    (s) =>
      s &&
      typeof s === 'object' &&
      (s as { kind?: string }).kind === KIND &&
      threadKey(String((s as CynthiaStaffThread).orgId), String((s as CynthiaStaffThread).userId)) === key,
  );
  const record = { ...thread, kind: KIND, id: `cynthia_${key}` };
  if (idx >= 0) sessions[idx] = record;
  else sessions.push(record);
  store.sessions = sessions;
  syncData({ sessions });
}

export function getStaffThread(orgId: string, userId: string): CynthiaStaffThread {
  const found = asThreads().find((t) => t.orgId === orgId && t.userId === userId);
  if (found) return found;
  return { userId, orgId, messages: [], updatedAt: new Date().toISOString() };
}

export function appendStaffMessage(
  orgId: string,
  userId: string,
  message: Omit<CynthiaStaffMessage, 'id' | 'timestamp'> & { id?: string; timestamp?: string },
): CynthiaStaffMessage {
  const thread = getStaffThread(orgId, userId);
  const full: CynthiaStaffMessage = {
    id: message.id ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: message.role,
    content: message.content,
    card: message.card,
    artifact: message.artifact,
    source: message.source,
    timestamp: message.timestamp ?? new Date().toISOString(),
  };
  thread.messages.push(full);
  if (thread.messages.length > 400) {
    thread.messages = thread.messages.slice(-400);
  }
  thread.updatedAt = full.timestamp;
  persistThread(thread);
  return full;
}

export function pushStaffCard(
  orgId: string,
  userId: string,
  cardInput: Omit<CynthiaStaffCard, 'id' | 'createdAt'> & { id?: string },
): CynthiaStaffCard {
  const card: CynthiaStaffCard = {
    ...cardInput,
    id: cardInput.id ?? `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    currency: cardInput.currency ?? 'GBP',
    actions: cardInput.actions ?? buildDefaultActions(cardInput),
  };

  appendStaffMessage(orgId, userId, {
    role: 'card',
    content: card.title,
    card,
    source: card.source ?? 'system',
  });

  return card;
}

function buildDefaultActions(
  card: Omit<CynthiaStaffCard, 'id' | 'createdAt'>,
): CynthiaCardAction[] {
  const actions: CynthiaCardAction[] = [];
  if (card.phone) {
    actions.push({ label: 'Call customer', kind: 'call', value: card.phone });
  }
  if (card.quoteId) {
    actions.push({ label: 'Open quote', kind: 'navigate', value: `/quotes` });
  }
  if (card.projectId) {
    actions.push({ label: 'Open project', kind: 'navigate', value: `/projects/${card.projectId}` });
  }
  if (card.customerId) {
    actions.push({ label: 'Open customer', kind: 'navigate', value: `/customers` });
  }
  if (!actions.some((a) => a.kind === 'navigate')) {
    actions.push({ label: 'Open Cynthia', kind: 'navigate', value: `/cynthia?card=${card.id ?? ''}` });
  }
  return actions;
}

/**
 * Resolve staff userId for Cynthia cards — fail-closed.
 * Never falls back to first-admin or default-staff.
 * Order: explicit userId → exact registered staff phone match → null (staff_not_resolved).
 */
export function resolveStaffUserId(opts: {
  userId?: string;
  staffPhone?: string;
  orgId?: string;
}): string | null {
  const explicit = opts.userId?.trim();
  if (explicit) {
    if (explicit === 'default-staff' || explicit === 'default') return null;
    const store = getDataStore();
    const team = Array.isArray(store.teamMembers) ? store.teamMembers : [];
    const found = team.find((m) => String(m.userId ?? m.id ?? '') === explicit);
    // Accept explicit profile UUID even if not in local team cache (authenticated header)
    if (found || explicit.length >= 8) return explicit;
    return null;
  }
  if (opts.staffPhone) {
    const store = getDataStore();
    const team = Array.isArray(store.teamMembers) ? store.teamMembers : [];
    const digits = opts.staffPhone.replace(/\D/g, '');
    if (digits.length >= 10) {
      const matches = team.filter((m) => {
        const p = String(m.phone ?? '').replace(/\D/g, '');
        return p && (p === digits || p.endsWith(digits.slice(-10)) || digits.endsWith(p.slice(-10)));
      });
      // Exact single match only — ambiguous phone matches are rejected
      if (matches.length === 1 && matches[0]?.userId) return String(matches[0].userId);
    }
  }
  return null;
}

export function listRecentCards(orgId: string, userId: string, limit = 20): CynthiaStaffCard[] {
  const thread = getStaffThread(orgId, userId);
  return thread.messages
    .filter((m) => m.role === 'card' && m.card)
    .map((m) => m.card!)
    .slice(-limit)
    .reverse();
}
