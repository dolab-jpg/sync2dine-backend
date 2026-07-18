/**
 * Sally platform receptionist — inbox brief, AI compose, read-aloud draft, confirm-only send.
 * Uses connected Gmail (mailbox) + OpenAI compose. Not Gemini-in-Gmail.
 */
import { handleComposeEmail, buildOfferVariables } from './compose-email-handler';
import { wrapSalesEmail } from './sales-email-html';
import { getSalesTemplate, renderSalesPlaceholders } from './sales-templates';
import { enqueueScheduledMessage } from './scheduled-messages-store';
import { getHomeOrgId } from './home-org';
import { executeMailboxTool } from './mailbox-routes';
import { listConnections } from './mailbox/mailbox-store';
import { syncConnection } from './mailbox/imapSyncService';

type SessionDraft = {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  messageId?: string;
  updatedAt: string;
};

const draftsBySession = new Map<string, SessionDraft>();

function sessionKey(callId?: string, staffUserId?: string): string {
  return (callId || staffUserId || 'platform').trim() || 'platform';
}

export function getReceptionistDraft(session: string): SessionDraft | undefined {
  return draftsBySession.get(session);
}

export function clearReceptionistDraft(session: string): void {
  draftsBySession.delete(session);
}

function resolveMailboxOwner(userId?: string): { orgId: string; userId: string } {
  const orgId = getHomeOrgId();
  const uid = (userId || process.env.PLATFORM_MAILBOX_USER_ID || '').trim();
  if (uid) return { orgId, userId: uid };
  const conns = listConnections(orgId);
  const first = conns.find((c) => c.status === 'connected') || conns[0];
  return { orgId, userId: first?.userId || 'platform_owner' };
}

/** Tool schemas for phone / chat Sally receptionist */
export const SALLY_RECEPTIONIST_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'briefInbox',
      description:
        'Check the platform connected Gmail inbox and brief the owner on useful emails (skip noise). Call when they ask what emails they have.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent emails to scan (default 15)' },
          syncFirst: { type: 'boolean', description: 'Sync mailbox before listing (default true)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'listRecentEmails',
      description: 'List recent emails from the connected platform Gmail.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getEmailThread',
      description: 'Read a full email thread by threadId or messageId.',
      parameters: {
        type: 'object',
        properties: {
          threadId: { type: 'string' },
          messageId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'composeSalesEmail',
      description:
        'Draft a Sync2Dine sales/company email with OpenAI from the owner instructions. Free-form OK (no template required). Stores a session draft — read it aloud before sending.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email' },
          customerName: { type: 'string' },
          restaurantName: { type: 'string' },
          notes: { type: 'string', description: 'What the owner wants said' },
          purpose: { type: 'string' },
          templateId: {
            type: 'string',
            enum: ['intro', 'demo_invite', 'demo_assets', 'quote', 'quote_chase', 'checkout', 'onboarding', 'followup'],
          },
          threadId: { type: 'string' },
          messageId: { type: 'string' },
        },
        required: ['notes'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'readDraftAloud',
      description: 'Return the current session email draft for speaking aloud to the owner.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendEmailReply',
      description:
        'Send the session draft (or provided email) from the connected Gmail. HARD REQUIRE confirmed=true after the owner approved the draft aloud. Never send without confirmation.',
      parameters: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['confirmed'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'scheduleSalesFollowUp',
      description: 'Schedule the current draft (or provided email) to send later automatically.',
      parameters: {
        type: 'object',
        properties: {
          sendAt: { type: 'string', description: 'ISO datetime' },
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          channel: { type: 'string', enum: ['email', 'whatsapp', 'both'] },
          toPhone: { type: 'string' },
          customerId: { type: 'string' },
          customerName: { type: 'string' },
          templateId: { type: 'string' },
        },
        required: ['sendAt'],
      },
    },
  },
];

export const SALLY_RECEPTIONIST_TOOL_NAMES = new Set(
  SALLY_RECEPTIONIST_TOOLS.map((t) => t.function.name),
);

export async function executeSallyReceptionistTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { callId?: string; staffUserId?: string; orgId?: string },
): Promise<Record<string, unknown>> {
  const sk = sessionKey(ctx.callId, ctx.staffUserId);
  const owner = resolveMailboxOwner(ctx.staffUserId);

  if (name === 'briefInbox' || name === 'listRecentEmails') {
    const limit = Number(args.limit) || (name === 'briefInbox' ? 15 : 10);
    const syncFirst = args.syncFirst !== false;
    const conns = listConnections(owner.orgId, owner.userId);
    const conn = conns.find((c) => c.status === 'connected') || conns[0];
    if (!conn) {
      return {
        ok: false,
        error: 'mailbox_not_connected',
        spokenHint:
          'No Gmail is connected for the platform yet. Connect it in Communications Hub under Mailbox, then ask me again.',
      };
    }
    if (syncFirst && name === 'briefInbox') {
      try {
        await syncConnection(conn.id);
      } catch (err) {
        console.warn('[sally-receptionist] sync failed:', err);
      }
    }
    const listed = await executeMailboxTool('listRecentEmails', { limit }, owner.orgId, owner.userId);
    if ('error' in listed && listed.error) {
      return {
        ok: false,
        error: String(listed.error),
        spokenHint: 'I could not read the inbox — check the mailbox connection.',
      };
    }
    const emails = (listed.emails as Array<{
      id: string;
      from: string;
      subject: string;
      snippet: string;
      receivedAt: string;
    }>) || [];

    if (name === 'listRecentEmails') {
      return {
        ok: true,
        ...listed,
        spokenHint: emails.length
          ? `You have ${emails.length} recent emails. Latest: ${emails[0].subject} from ${emails[0].from}.`
          : 'Inbox looks empty after sync.',
      };
    }

    // Triage with OpenAI
    try {
      const { createLLMClientForOrg, defaultChatModelForProvider } = await import('./llm-connection');
      const { client, provider } = await createLLMClientForOrg(owner.orgId, '/api/ai/compose-email', {});
      const model = defaultChatModelForProvider(provider, 'gpt-4o-mini');
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are Sally, Sync2Dine platform receptionist. Triage inbox for the owner. Return JSON {"useful":[{"from","subject","why","priority":"high"|"medium"}],"noiseCount":number,"spokenBrief":"2-4 spoken sentences for the owner"}. Prioritise restaurant leads, sales replies, demos, payments, urgent human mail. Mark newsletters/spam/automated as noise.',
          },
          {
            role: 'user',
            content: JSON.stringify(emails.slice(0, limit)),
          },
        ],
      });
      const raw = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw) as {
        useful?: Array<{ from?: string; subject?: string; why?: string; priority?: string }>;
        noiseCount?: number;
        spokenBrief?: string;
      };
      const useful = parsed.useful || [];
      return {
        ok: true,
        usefulCount: useful.length,
        noiseCount: parsed.noiseCount ?? Math.max(0, emails.length - useful.length),
        useful,
        emails,
        spokenHint:
          parsed.spokenBrief
          || (useful.length
            ? `You have ${useful.length} useful emails. ${useful.map((u) => `${u.subject} from ${u.from}`).join('. ')}`
            : `I scanned ${emails.length} emails — nothing urgent stood out.`),
      };
    } catch (err) {
      const top = emails.slice(0, 5);
      return {
        ok: true,
        usefulCount: top.length,
        emails: top,
        spokenHint: top.length
          ? `You have ${emails.length} recent emails. Top ones: ${top.map((e) => `${e.subject} from ${e.from}`).join('; ')}.`
          : 'Inbox looks empty.',
        triageError: err instanceof Error ? err.message : 'triage_failed',
      };
    }
  }

  if (name === 'getEmailThread' || name === 'searchEmails') {
    const result = await executeMailboxTool(name, args, owner.orgId, owner.userId);
    return { ok: !('error' in result && result.error), ...result };
  }

  if (name === 'composeSalesEmail') {
    const notes = String(args.notes || args.purpose || '').trim();
    if (!notes) {
      return {
        ok: false,
        error: 'notes_required',
        spokenHint: 'Tell me what you want the email to say, and who it is for.',
      };
    }
    const composed = await handleComposeEmail({
      orgId: owner.orgId,
      notes,
      purpose: String(args.purpose || ''),
      templateId: args.templateId ? String(args.templateId) : undefined,
      customerName: args.customerName ? String(args.customerName) : undefined,
      restaurantName: args.restaurantName ? String(args.restaurantName) : undefined,
    });
    const to = String(args.to || '').trim();
    const draft: SessionDraft = {
      to,
      subject: composed.subject,
      body: composed.body,
      threadId: args.threadId ? String(args.threadId) : undefined,
      messageId: args.messageId ? String(args.messageId) : undefined,
      updatedAt: new Date().toISOString(),
    };
    draftsBySession.set(sk, draft);
    const preview = draft.body.length > 400 ? `${draft.body.slice(0, 400)}…` : draft.body;
    return {
      ok: true,
      draft,
      spokenHint: `I've drafted an email${to ? ` to ${to}` : ''}. Subject: ${draft.subject}. Here's the body: ${preview}. Say if you want changes, or say fine go ahead and I'll send it.`,
    };
  }

  if (name === 'readDraftAloud') {
    const draft = draftsBySession.get(sk);
    if (!draft) {
      return {
        ok: false,
        error: 'no_draft',
        spokenHint: 'There is no draft yet — tell me who to email and what to say first.',
      };
    }
    return {
      ok: true,
      draft,
      spokenHint: `Draft to ${draft.to || 'the recipient'}. Subject: ${draft.subject}. Body: ${draft.body}`,
    };
  }

  if (name === 'sendEmailReply') {
    if (args.confirmed !== true && args.confirmed !== 'true') {
      return {
        ok: false,
        error: 'confirmation_required',
        spokenHint:
          'I have not sent anything. Approve the draft first — say fine, go ahead, or send it — then I will send.',
      };
    }
    const draft = draftsBySession.get(sk);
    const to = String(args.to || draft?.to || '').trim();
    const subject = String(args.subject || draft?.subject || '').trim();
    const body = String(args.body || draft?.body || '').trim();
    if (!to || !subject || !body) {
      return {
        ok: false,
        error: 'missing_draft_fields',
        spokenHint: 'I need a recipient, subject, and body before I can send.',
      };
    }
    const wrapped = wrapSalesEmail(body, {
      subject,
      heroTitle: subject,
      companyName: 'Sync2Dine',
      sentBy: 'Sally · Sync2Dine',
    });
    const result = await executeMailboxTool(
      'sendEmailReply',
      { to, subject, body: wrapped.text, html: wrapped.html, confirmed: true },
      owner.orgId,
      owner.userId,
    );
    if (result.success || result.ok) {
      clearReceptionistDraft(sk);
      return {
        ok: true,
        ...result,
        spokenHint: `Sent to ${to}. Subject: ${subject}.`,
      };
    }
    return {
      ok: false,
      ...result,
      spokenHint:
        `I could not send that email${result.error ? `: ${result.error}` : ''}. Check the mailbox connection or try again.`,
    };
  }

  if (name === 'scheduleSalesFollowUp') {
    const draft = draftsBySession.get(sk);
    const sendAt = String(args.sendAt || '').trim();
    if (!sendAt || !Number.isFinite(Date.parse(sendAt))) {
      return {
        ok: false,
        error: 'sendAt_required',
        spokenHint: 'When should I send it? Give me a date and time.',
      };
    }
    const to = String(args.to || draft?.to || '').trim();
    const subject = String(args.subject || draft?.subject || '').trim();
    const body = String(args.body || draft?.body || '').trim();
    if (!subject || !body) {
      return {
        ok: false,
        error: 'missing_body',
        spokenHint: 'Compose or provide the email first, then I can schedule it.',
      };
    }
    const channel = String(args.channel || 'email').toLowerCase();
    const channels: Array<'email' | 'whatsapp'> = [];
    if (channel === 'whatsapp' || channel === 'both') channels.push('whatsapp');
    if (channel === 'email' || channel === 'both' || !channels.length) channels.push('email');
    if (channels.includes('email') && !to) {
      return {
        ok: false,
        error: 'email_required',
        spokenHint: 'I need an email address to schedule that.',
      };
    }
    const job = enqueueScheduledMessage({
      orgId: owner.orgId,
      sendAt: new Date(sendAt).toISOString(),
      channels,
      toEmail: to || undefined,
      toPhone: args.toPhone ? String(args.toPhone) : undefined,
      customerId: args.customerId ? String(args.customerId) : undefined,
      customerName: args.customerName ? String(args.customerName) : undefined,
      templateId: args.templateId ? String(args.templateId) : undefined,
      subject,
      body,
      createdBy: 'sally',
      aim: 'followup',
      heroTitle: subject,
    });
    return {
      ok: true,
      jobId: job.id,
      sendAt: job.sendAt,
      spokenHint: `Scheduled for ${new Date(job.sendAt).toLocaleString('en-GB')}. It will send itself — no further action needed.`,
    };
  }

  return { ok: false, error: 'unknown_receptionist_tool', spokenHint: 'I do not have that email tool.' };
}

/** Fill a catalog template without AI (for hub / assets). */
export function fillSalesTemplate(
  templateId: string,
  extra: Record<string, string | undefined> = {},
): { subject: string; body: string } | null {
  const t = getSalesTemplate(templateId);
  if (!t) return null;
  const vars = buildOfferVariables(extra);
  return {
    subject: renderSalesPlaceholders(t.subject, vars),
    body: renderSalesPlaceholders(t.body, vars),
  };
}
