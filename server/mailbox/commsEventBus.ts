import { randomUUID } from 'crypto';
import { getDataStore, syncData } from '../data-store';
import { handleCyrusViaOrchestrator } from '../cyrus-orchestrator';
import { runLeadEmailAgent } from './leadEmailAgent';
import type { CachedEmailMessage } from './types';
import { getConnection } from './mailbox-store';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function resolveContactByEmail(email: string): {
  customerId: string | null;
  customerName: string;
  projectId: string | null;
} {
  const store = getDataStore();
  const normalized = normalizeEmail(email);
  const customer = store.customers.find(
    c => normalizeEmail(String(c.email ?? '')) === normalized
  );
  const contact = store.contacts.find(
    c => normalizeEmail(String(c.email ?? '')) === normalized
  );
  const customerId = customer
    ? String(customer.id)
    : contact
      ? String(contact.customerId)
      : null;
  const customerName = customer
    ? String(customer.name)
    : contact
      ? String(contact.name)
      : email;
  const project = customerId
    ? store.projects.find(
      p => String(p.customerId) === customerId && p.status !== 'completed'
    )
    : undefined;
  return {
    customerId,
    customerName,
    projectId: project ? String(project.id) : null,
  };
}

function appendProjectMessage(projectId: string, msg: Record<string, unknown>): void {
  const store = getDataStore();
  const project = store.projects.find(p => String(p.id) === projectId);
  if (!project) return;
  const messages = [...(project.messages as unknown[] ?? []), msg];
  project.messages = messages;
  syncData(store);
}

export async function processInboundEmail(message: CachedEmailMessage, orgId = 'default'): Promise<void> {
  const conn = getConnection(message.connectionId);
  const resolved = resolveContactByEmail(message.fromAddr);
  const timestamp = message.receivedAt;

  if (resolved.projectId) {
    appendProjectMessage(resolved.projectId, {
      id: randomUUID(),
      from: message.fromName || message.fromAddr,
      fromRole: 'customer',
      message: message.textBody || message.snippet,
      subject: message.subject,
      timestamp,
      channel: 'email',
      emailSent: false,
      direction: 'inbound',
      externalId: message.messageId,
    });
  }

  if (!resolved.customerId) {
    try {
      await runLeadEmailAgent(message, orgId);
    } catch (err) {
      console.error('leadEmailAgent error:', err);
    }
    return;
  }

  try {
    const reply = await handleCyrusViaOrchestrator({
      messages: [{ role: 'user', content: `[Email from ${message.fromAddr}] ${message.subject}\n\n${message.textBody || message.snippet}` }],
      customerContext: {
        customerId: resolved.customerId,
        customerName: resolved.customerName,
        projectId: resolved.projectId ?? undefined,
      },
      projectContext: resolved.projectId ? { projectId: resolved.projectId } : undefined,
    });

    if (resolved.projectId && reply.content) {
      appendProjectMessage(resolved.projectId, {
        id: randomUUID(),
        from: conn?.displayName || 'Cyrus',
        fromRole: 'office',
        message: reply.content,
        timestamp: new Date().toISOString(),
        channel: 'email',
        direction: 'outbound',
        aiGenerated: true,
      });
    }
  } catch (err) {
    console.error('commsEventBus orchestrator error:', err);
  }
}

export async function processNewMessages(messages: CachedEmailMessage[], orgId = 'default'): Promise<void> {
  for (const msg of messages) {
    await processInboundEmail(msg, orgId);
  }
}
