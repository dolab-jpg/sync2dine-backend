/** Server-side planning application mutations. */
import { getDataStore, syncData } from './data-store';
import { PLANNING_ACTION_NAMES } from './planning-tools';

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function isPlanningWriteAction(action: string): boolean {
  return (PLANNING_ACTION_NAMES as readonly string[]).includes(action);
}

function findApplication(input: Record<string, unknown>): { app: Record<string, unknown>; idx: number } | null {
  const store = getDataStore();
  const appId = firstString(input.applicationId, input.id);
  if (appId) {
    const idx = store.planningApplications.findIndex((a) => String(a.id) === appId);
    if (idx >= 0) return { app: store.planningApplications[idx], idx };
  }
  if (store.planningApplications.length > 0) {
    return { app: store.planningApplications[0], idx: 0 };
  }
  return null;
}

function saveApplication(idx: number, app: Record<string, unknown>): Record<string, unknown> {
  const store = getDataStore();
  const record = { ...app, updatedAt: new Date().toISOString() };
  if (idx >= 0 && idx < store.planningApplications.length) {
    store.planningApplications[idx] = record;
  } else {
    store.planningApplications.unshift(record);
  }
  syncData(store);
  return record;
}

export function executePlanningWrite(
  action: string,
  input: Record<string, unknown>,
): { ok: boolean; summary: string; output: Record<string, unknown> } {
  let found = findApplication(input);
  let app = found?.app ?? {
    id: firstString(input.applicationId) ?? `PA${Date.now()}`,
    stage: 'pricing',
    createdAt: new Date().toISOString(),
    changeRequests: [],
    comments: [],
    drawings: [],
    emails: [],
    tasks: [],
  };
  let idx = found?.idx ?? -1;

  if (action === 'updateApplication') {
    app = {
      ...app,
      ...(input.title ? { title: input.title } : {}),
      ...(input.address ? { address: input.address } : {}),
      ...(input.applicationType ? { applicationType: input.applicationType } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.customerName ? { customerName: input.customerName } : {}),
      ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
    };
  }

  if (action === 'setStage') {
    app = { ...app, stage: input.stage ?? app.stage };
  }

  if (action === 'setPricing') {
    app = {
      ...app,
      pricing: {
        ...(app.pricing as Record<string, unknown> ?? {}),
        amount: input.amount,
        scope: input.scope,
        sentAt: (app.pricing as Record<string, unknown> | undefined)?.sentAt,
      },
    };
  }

  if (action === 'sendPricingEmail' || action === 'sendReviewEmail' || action === 'sendCourtesyEmail' || action === 'sendCouncilReply') {
    const emails = Array.isArray(app.emails) ? [...app.emails as unknown[]] : [];
    emails.push({
      id: `PE${Date.now()}`,
      type: action,
      subject: input.subject,
      body: input.body,
      sentAt: new Date().toISOString(),
      status: 'sent',
    });
    app = { ...app, emails };
    if (action === 'sendPricingEmail') {
      app = { ...app, pricing: { ...(app.pricing as Record<string, unknown> ?? {}), sentAt: new Date().toISOString() } };
    }
  }

  if (action === 'logDrawing') {
    const drawings = Array.isArray(app.drawings) ? [...app.drawings as unknown[]] : [];
    drawings.push({
      id: `DR${Date.now()}`,
      title: input.title ?? 'Drawing',
      version: input.version ?? '1',
      loggedAt: new Date().toISOString(),
    });
    app = { ...app, drawings, drawingsCount: drawings.length };
  }

  if (action === 'recordCouncil') {
    app = {
      ...app,
      council: {
        ...(app.council as Record<string, unknown> ?? {}),
        name: input.name ?? (app.council as Record<string, unknown> | undefined)?.name,
        reference: input.reference,
        portalUrl: input.portalUrl,
        submittedAt: input.submittedAt ?? (app.council as Record<string, unknown> | undefined)?.submittedAt,
        validationOfficer: input.validationOfficer,
        targetDecisionDate: input.targetDecisionDate,
      },
    };
  }

  if (action === 'raiseChangeRequest') {
    const changes = Array.isArray(app.changeRequests) ? [...app.changeRequests as unknown[]] : [];
    changes.push({
      id: `CR${Date.now()}`,
      description: input.description,
      deadline: input.deadline,
      status: 'open',
      sourceEmail: input.sourceEmail,
      aiComment: input.aiComment,
      createdAt: new Date().toISOString(),
    });
    app = { ...app, changeRequests: changes, stage: input.stage ?? 'changes_requested' };
  }

  if (action === 'resolveChangeRequest') {
    const changeId = firstString(input.changeRequestId, input.id);
    const changes = (Array.isArray(app.changeRequests) ? app.changeRequests as Array<Record<string, unknown>> : []).map((c) =>
      changeId && String(c.id) === changeId ? { ...c, status: 'resolved', resolvedAt: new Date().toISOString() } : c
    );
    app = { ...app, changeRequests: changes };
  }

  if (action === 'setDeadline') {
    app = { ...app, deadline: input.deadline ?? input.date, deadlineNote: input.note };
  }

  if (action === 'addComment') {
    const comments = Array.isArray(app.comments) ? [...app.comments as unknown[]] : [];
    comments.push({
      id: `PC${Date.now()}`,
      body: input.body ?? input.comment,
      author: input.author ?? 'TradePro AI',
      createdAt: new Date().toISOString(),
    });
    app = { ...app, comments };
  }

  if (action === 'portalStatusCheck') {
    const comments = Array.isArray(app.comments) ? [...app.comments as unknown[]] : [];
    comments.push({
      id: `PC${Date.now()}`,
      body: `Portal check: ${String(input.note ?? 'Staff should verify council portal status.')}`,
      author: 'TradePro AI',
      createdAt: new Date().toISOString(),
    });
    app = { ...app, comments };
  }

  if (action === 'markDecision') {
    app = { ...app, decision: input.decision ?? 'approved', decisionNote: input.note, stage: input.decision === 'refused' ? 'refused' : 'approved' };
  }

  if (action === 'generatePostApprovalTasks') {
    const tasks = Array.isArray(app.tasks) ? [...app.tasks as unknown[]] : [];
    const newTasks = Array.isArray(input.tasks) ? input.tasks as unknown[] : [];
    for (const t of newTasks) {
      tasks.push({
        id: `PT${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
        title: typeof t === 'string' ? t : String((t as Record<string, unknown>).title ?? t),
        workstream: input.workstream ?? 'general',
        status: 'open',
        createdAt: new Date().toISOString(),
      });
    }
    app = { ...app, tasks, stage: 'post_approval' };
  }

  if (action === 'convertToProject') {
    app = { ...app, convertedProjectId: input.projectId ?? `P${Date.now()}`, stage: 'completed' };
  }

  const saved = saveApplication(idx, app);
  const labels: Record<string, string> = {
    updateApplication: 'Planning application updated',
    setStage: `Stage set to ${String(input.stage ?? saved.stage)}`,
    setPricing: 'Planning pricing saved',
    sendPricingEmail: 'Pricing email logged',
    sendReviewEmail: 'Review email logged',
    sendCourtesyEmail: 'Courtesy email logged',
    sendCouncilReply: 'Council reply logged',
    logDrawing: 'Drawing logged',
    recordCouncil: 'Council details recorded',
    raiseChangeRequest: 'Change request raised',
    resolveChangeRequest: 'Change request resolved',
    setDeadline: 'Deadline set',
    addComment: 'Comment added',
    portalStatusCheck: 'Portal check logged',
    markDecision: `Decision recorded: ${String(input.decision ?? 'approved')}`,
    generatePostApprovalTasks: 'Post-approval tasks generated',
    convertToProject: 'Planning application converted to project',
  };

  return {
    ok: true,
    summary: labels[action] ?? `${action} applied.`,
    output: { ...input, applicationId: saved.id, ok: true },
  };
}
