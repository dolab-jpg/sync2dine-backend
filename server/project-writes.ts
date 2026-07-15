/**
 * Server-side project mutations — ports applyProposedAction from projectAiService.
 */
import { randomBytes } from 'crypto';
import {
  getDataStore,
  getProjectById,
  syncData,
  updateProjectRecord,
} from './data-store';

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function generateToken(): string {
  return randomBytes(16).toString('hex');
}

export function createProjectFromQuoteServer(
  quote: Record<string, unknown>,
  customer: Record<string, unknown>,
): Record<string, unknown> {
  const id = `P${Date.now()}`;
  const total = Number(quote.total ?? 0);
  const deposit = Math.round(total * 0.25);
  const progress = Math.round(total * 0.5);
  const completion = total - deposit - progress;
  const start = new Date();
  const finish = new Date(Date.now() + 21 * 86400000);
  const project = {
    id,
    customerId: String(quote.customerId ?? customer.id ?? ''),
    customerName: String(quote.customerName ?? customer.name ?? 'Customer'),
    customerEmail: String(customer.email ?? ''),
    quoteId: String(quote.id ?? ''),
    projectName: `${String(quote.customerName ?? customer.name ?? 'Customer')} - ${String(quote.tradeName ?? 'Project')}`,
    tradeId: quote.tradeId,
    tradeName: quote.tradeName,
    address: String(customer.address ?? ''),
    startDate: start.toISOString().split('T')[0],
    finishDate: finish.toISOString().split('T')[0],
    status: 'planning',
    description: `Project created from quote ${String(quote.id ?? '')}`,
    assignedBuilder: 'Unassigned',
    totalCustomerCost: total,
    workingDaysOff: [],
    milestones: [
      { id: 'M1', title: 'Start on site', targetDate: start.toISOString().split('T')[0], completed: false },
      { id: 'M2', title: 'First fix complete', targetDate: new Date(start.getTime() + 7 * 86400000).toISOString().split('T')[0], completed: false },
      { id: 'M3', title: 'Handover', targetDate: finish.toISOString().split('T')[0], completed: false },
    ],
    tasks: [],
    paymentStages: [
      { id: 'PS1', name: 'Deposit', percentage: 25, amount: deposit, status: 'due', dueDate: start.toISOString().split('T')[0] },
      { id: 'PS2', name: 'Progress', percentage: 50, amount: progress, status: 'pending' },
      { id: 'PS3', name: 'Completion', percentage: 25, amount: completion, status: 'pending', notes: 'On sign-off' },
    ],
    builderPayments: [],
    invoices: [],
    contracts: [],
    files: [],
    messages: [],
    contractorComms: [],
    aiActions: [],
    photos: [],
    designItems: [],
    changeOrders: [],
    costEntries: [],
    timesheets: [],
    whatsappMode: 'individual',
    portalToken: generateToken(),
    escalated: false,
    customerAutoUpdates: false,
    plans: [],
    assignedContractors: [],
    snags: [],
    handover: {},
    createdAt: new Date().toISOString(),
  };
  const store = getDataStore();
  store.projects.unshift(project);
  syncData(store);
  return project;
}

export function buildDefaultPaymentStages(total: number): Array<Record<string, unknown>> {
  const pct = [10, 40, 30, 20];
  let allocated = 0;
  return pct.map((p, i) => {
    const amount = i === pct.length - 1 ? total - allocated : Math.round(total * (p / 100));
    allocated += amount;
    return {
      id: `PS${Date.now()}${i}`,
      name: ['Deposit', 'First fix', 'Second fix', 'Completion'][i] ?? `Stage ${i + 1}`,
      percentage: p,
      amount,
      status: i === 0 ? 'due' : 'pending',
    };
  });
}

export function applyProjectWriteAction(
  projectId: string,
  action: string,
  output: Record<string, unknown>,
  approvedBy: string,
): { ok: boolean; summary: string; changeOrderId?: string; output: Record<string, unknown> } {
  const project = getProjectById(projectId);
  if (!project) {
    return { ok: false, summary: 'Project not found.', output };
  }

  const updates: Record<string, unknown> = {};
  let createdChangeOrderId: string | undefined;
  const log = {
    id: `AI${Date.now()}`,
    action,
    input: {},
    output,
    status: 'approved',
    createdAt: new Date().toISOString(),
    approvedBy,
  };
  const aiActions = [...(Array.isArray(project.aiActions) ? project.aiActions as unknown[] : []), log];
  updates.aiActions = aiActions;

  if (action === 'proposePaymentPlan' || action === 'savePaymentPlan') {
    const stagesRaw = Array.isArray(output.stages) ? output.stages as Array<Record<string, unknown>> : [];
    const total = Number(project.totalCustomerCost ?? 0);
    updates.paymentStages = stagesRaw.map((s, i) => ({
      id: String(s.id ?? `PS${Date.now()}${i}`),
      name: String(s.name ?? s.label ?? `Stage ${i + 1}`),
      percentage: Number(s.percentage ?? s.percent ?? 0),
      amount: Number(s.amount ?? (total * Number(s.percentage ?? 0) / 100)),
      status: String(s.status ?? 'pending'),
      notes: String(s.notes ?? s.description ?? ''),
      dueDate: s.dueDate ? String(s.dueDate) : undefined,
    }));
  }

  if (action === 'proposeSchedule' || action === 'saveProjectSchedule') {
    if (output.workingDaysOff) updates.workingDaysOff = output.workingDaysOff;
    if (output.tasks) {
      const existing = Array.isArray(project.tasks) ? project.tasks as Array<Record<string, unknown>> : [];
      updates.tasks = [
        ...existing,
        ...(output.tasks as Array<Record<string, unknown>>).map((t, i) => ({
          id: `T${Date.now()}${i}`,
          title: String(t.title),
          description: String(t.description ?? ''),
          assignedTo: String(t.assignedTo ?? project.assignedBuilder ?? 'Unassigned'),
          status: 'todo',
          targetDate: String(t.targetDate ?? ''),
          priority: String(t.priority ?? 'medium'),
          photos: [],
          createdAt: new Date().toISOString(),
          createdBy: approvedBy,
          source: 'ai',
        })),
      ];
    }
    if (output.milestones) {
      const existing = Array.isArray(project.milestones) ? project.milestones as unknown[] : [];
      updates.milestones = [
        ...existing,
        ...(output.milestones as Array<Record<string, unknown>>).map((m, i) => ({
          id: `M${Date.now()}${i}`,
          title: String(m.title),
          targetDate: String(m.targetDate ?? ''),
          completed: false,
        })),
      ];
    }
  }

  if (action === 'proposePlan') {
    if (output.tasks) {
      const existing = Array.isArray(project.tasks) ? project.tasks as Array<Record<string, unknown>> : [];
      updates.tasks = [
        ...existing,
        ...(output.tasks as Array<Record<string, unknown>>).map((t, i) => ({
          id: `T${Date.now()}${i}`,
          title: String(t.title),
          description: String(t.description ?? ''),
          assignedTo: String(t.owner ?? t.assignedTo ?? project.assignedBuilder ?? 'Unassigned'),
          status: 'todo',
          targetDate: String(t.due ?? t.targetDate ?? ''),
          priority: 'medium',
          photos: [],
          createdAt: new Date().toISOString(),
          createdBy: approvedBy,
          source: 'ai',
        })),
      ];
    }
    if (output.title) {
      const plans = Array.isArray(project.plans) ? project.plans as unknown[] : [];
      updates.plans = [
        ...plans,
        {
          id: `PLAN${Date.now()}`,
          title: String(output.title),
          status: 'draft',
          cadence: String(output.cadence ?? 'daily'),
          notes: `Cadence: ${String(output.cadence ?? 'daily')}`,
        },
      ];
    }
  }

  if (action === 'checkPaymentGate') {
    const evidence = Array.isArray(output.evidenceNeeded)
      ? (output.evidenceNeeded as unknown[]).map(String).filter(Boolean)
      : [];
    const messages = Array.isArray(project.messages) ? [...project.messages as unknown[]] : [];
    messages.push({
      id: `PM${Date.now()}`,
      from: approvedBy,
      fromRole: 'office',
      body: `Payment gate check for ${String(output.stageName ?? 'stage')}. Evidence needed: ${evidence.join(', ') || 'none listed'}.`,
      channel: 'app',
      timestamp: new Date().toISOString(),
      emailSent: false,
    });
    updates.messages = messages;
  }

  if (action === 'draftInvoice') {
    const invoices = Array.isArray(project.invoices) ? project.invoices as unknown[] : [];
    invoices.push({
      id: `INV${Date.now()}`,
      lineItems: Array.isArray(output.lineItems) ? output.lineItems : [],
      total: Number(output.total ?? 0) || Number(project.totalCustomerCost ?? 0) * 0.4,
      status: 'draft',
      createdAt: new Date().toISOString(),
    });
    updates.invoices = invoices;
  }

  if (action === 'draftContract') {
    const contracts = Array.isArray(project.contracts) ? project.contracts as unknown[] : [];
    contracts.push({
      id: `CON${Date.now()}`,
      terms: String(output.terms ?? ''),
      status: 'draft',
      createdAt: new Date().toISOString(),
    });
    updates.contracts = contracts;
  }

  if (action === 'draftBuilderMessage' || action === 'draftCustomerMessage') {
    const body = String(output.body ?? '').trim();
    if (body) {
      if (action === 'draftBuilderMessage') {
        const comms = Array.isArray(project.contractorComms) ? project.contractorComms as unknown[] : [];
        comms.push({
          id: `CC${Date.now()}`,
          builderId: 'builder',
          builderName: project.assignedBuilder,
          subject: String(output.subject ?? 'Message'),
          body,
          status: 'draft',
          channel: 'app',
          createdAt: new Date().toISOString(),
        });
        updates.contractorComms = comms;
      } else {
        const messages = Array.isArray(project.messages) ? [...project.messages as unknown[]] : [];
        messages.push({
          id: `PM${Date.now()}`,
          from: approvedBy,
          fromRole: 'office',
          body,
          channel: 'app',
          timestamp: new Date().toISOString(),
          emailSent: false,
        });
        updates.messages = messages;
      }
    }
  }

  if (action === 'logBuilderPrice') {
    const comms = Array.isArray(project.contractorComms) ? project.contractorComms as unknown[] : [];
    comms.push({
      id: `CC${Date.now()}`,
      builderId: 'builder',
      builderName: String(output.builderName ?? project.assignedBuilder ?? 'Builder'),
      subject: 'Price quoted',
      body: String(output.notes ?? 'Builder price recorded'),
      priceQuoted: readOptionalNumber(output.priceQuoted),
      status: 'replied',
      channel: 'app',
      createdAt: new Date().toISOString(),
    });
    updates.contractorComms = comms;
  }

  if (action === 'updateTaskStatus') {
    const taskId = firstString(output.taskId);
    const taskTitle = firstString(output.taskTitle)?.toLowerCase();
    const tasks = Array.isArray(project.tasks) ? (project.tasks as Array<Record<string, unknown>>).map((t) => {
      const matchesId = taskId && String(t.id) === taskId;
      const title = String(t.title ?? '').toLowerCase();
      const matchesTitle = taskTitle && (title.includes(taskTitle) || taskTitle.includes(title));
      if (!matchesId && !matchesTitle) return t;
      return {
        ...t,
        status: firstString(output.status) ?? 'completed',
        targetDate: firstString(output.targetDate) ?? t.targetDate,
        completedAt: output.status === 'completed' ? new Date().toISOString() : t.completedAt,
      };
    }) : [];
    updates.tasks = tasks;
  }

  if (action === 'tagPhoto') {
    const files = Array.isArray(project.files) ? [...project.files as Array<Record<string, unknown>>] : [];
    if (files.length > 0) {
      const idx = output.fileId
        ? files.findIndex((f) => String(f.id) === String(output.fileId))
        : files.length - 1;
      if (idx >= 0) {
        files[idx] = { ...files[idx], caption: String(output.caption ?? '') };
        updates.files = files;
      }
    }
  }

  if (action === 'assessExtraFromPhotos' || action === 'assessProgress') {
    const summary = firstString(output.summary) ?? (action === 'assessProgress' ? 'Progress assessed from site photos.' : 'Extra assessed from photos.');
    const messages = Array.isArray(project.messages) ? [...project.messages as unknown[]] : [];
    messages.push({
      id: `PM${Date.now()}`,
      from: approvedBy,
      fromRole: 'office',
      body: `${action === 'assessProgress' ? 'Vision progress' : 'Vision extra'} assessment: ${summary}`,
      channel: 'app',
      timestamp: new Date().toISOString(),
      emailSent: false,
    });
    updates.messages = messages;
  }

  if (action === 'proposeChangeOrder') {
    const changeOrderId = `CO${Date.now()}`;
    createdChangeOrderId = changeOrderId;
    const orders = Array.isArray(project.changeOrders) ? project.changeOrders as unknown[] : [];
    orders.push({
      id: changeOrderId,
      title: firstString(output.title) ?? 'Change order',
      amount: readOptionalNumber(output.amount) ?? readOptionalNumber(output.amountMax) ?? 0,
      amountMin: readOptionalNumber(output.amountMin),
      amountMax: readOptionalNumber(output.amountMax),
      status: 'proposed',
      createdAt: new Date().toISOString(),
      description: firstString(output.description),
      reason: firstString(output.reason),
    });
    updates.changeOrders = orders;
  }

  if (action === 'recordCostEntry') {
    const total = readOptionalNumber(output.total) ?? 0;
    const supplier = firstString(output.supplier) ?? 'Supplier';
    const entries = Array.isArray(project.costEntries) ? project.costEntries as unknown[] : [];
    entries.push({
      id: `CE${Date.now()}`,
      projectId,
      builderId: firstString(output.builderId) ?? 'ai',
      type: 'ai',
      supplier,
      date: new Date().toISOString().split('T')[0],
      items: Array.isArray(output.items) ? output.items : [{ description: supplier, qty: 1, unitPrice: total, total, category: 'other' }],
      subtotal: total,
      vat: 0,
      total,
      aiSummary: firstString(output.aiSummary) ?? `Recorded: ${supplier} — £${total}`,
      status: 'recorded',
      createdAt: new Date().toISOString(),
    });
    updates.costEntries = entries;
  }

  if (action === 'fixCostEntry') {
    const entryId = firstString(output.entryId);
    if (entryId) {
      updates.costEntries = (Array.isArray(project.costEntries) ? project.costEntries as Array<Record<string, unknown>> : []).map((entry) => {
        if (String(entry.id) !== entryId) return entry;
        const total = readOptionalNumber(output.total) ?? Number(entry.total ?? 0);
        return {
          ...entry,
          supplier: firstString(output.supplier) ?? entry.supplier,
          total,
          subtotal: total,
          status: 'recorded',
        };
      });
    }
  }

  if (action === 'logHours') {
    const hours = readOptionalNumber(output.hours) ?? 0;
    const rate = readOptionalNumber(output.rate) ?? 25;
    const labourCost = Math.round(hours * rate * 100) / 100;
    const sheets = Array.isArray(project.timesheets) ? project.timesheets as unknown[] : [];
    sheets.push({
      id: `TS${Date.now()}`,
      projectId,
      builderId: firstString(output.builderId) ?? 'ai',
      clockIn: new Date().toISOString(),
      clockOut: new Date(Date.now() + hours * 3600000).toISOString(),
      hours,
      rate,
      labourCost,
      notes: firstString(output.notes),
    });
    updates.timesheets = sheets;
    output = { ...output, hours, labourCost };
  }

  if (action === 'correctTimesheet') {
    const timesheetId = firstString(output.timesheetId);
    if (timesheetId) {
      updates.timesheets = (Array.isArray(project.timesheets) ? project.timesheets as Array<Record<string, unknown>> : []).map((t) => {
        if (String(t.id) !== timesheetId) return t;
        const hours = readOptionalNumber(output.hours) ?? Number(t.hours ?? 0);
        const rate = readOptionalNumber(output.rate) ?? Number(t.rate ?? 25);
        return { ...t, hours, rate, labourCost: Math.round(hours * rate * 100) / 100 };
      });
    }
  }

  if (action === 'sendBuilderBrief' || action === 'sendContractorBrief' || action === 'requestSitePhotos') {
    const body = firstString(output.body) ?? (action === 'requestSitePhotos' ? 'Please send site photos.' : '');
    const comms = Array.isArray(project.contractorComms) ? project.contractorComms as unknown[] : [];
    comms.push({
      id: `CC${Date.now()}`,
      builderId: 'builder',
      builderName: String(project.assignedBuilder ?? 'Builder'),
      subject: action === 'requestSitePhotos' ? 'Site photos requested' : String(output.subject ?? 'Brief'),
      body,
      status: action === 'sendBuilderBrief' || action === 'sendContractorBrief' ? 'sent' : 'requested',
      channel: 'whatsapp',
      createdAt: new Date().toISOString(),
    });
    updates.contractorComms = comms;
  }

  if (action === 'relayCustomerUpdate') {
    const body = firstString(output.body) ?? '';
    if (body) {
      const messages = Array.isArray(project.messages) ? [...project.messages as unknown[]] : [];
      messages.push({
        id: `PM${Date.now()}`,
        from: approvedBy,
        fromRole: 'office',
        body: `Customer update: ${body}`,
        channel: 'whatsapp',
        timestamp: new Date().toISOString(),
        emailSent: false,
      });
      updates.messages = messages;
    }
  }

  if (action === 'logBuilderReply') {
    const body = firstString(output.body) ?? '';
    const fromPhone = firstString(output.fromPhone) ?? '';
    if (body) {
      const comms = Array.isArray(project.contractorComms) ? project.contractorComms as unknown[] : [];
      comms.push({
        id: `CC${Date.now()}`,
        builderId: 'builder',
        builderName: String(project.assignedBuilder ?? 'Builder'),
        subject: 'Builder reply',
        body,
        status: 'replied',
        channel: 'whatsapp',
        senderPhone: fromPhone,
        createdAt: new Date().toISOString(),
      });
      updates.contractorComms = comms;
    }
  }

  if (action === 'notifyCustomerChangeOrder') {
    const changeOrderId = firstString(output.changeOrderId);
    const orders = Array.isArray(project.changeOrders) ? project.changeOrders as Array<Record<string, unknown>> : [];
    updates.changeOrders = orders.map((o) =>
      changeOrderId && String(o.id) === changeOrderId
        ? { ...o, status: 'pending_customer', notifiedAt: new Date().toISOString() }
        : o
    );
  }

  updateProjectRecord(projectId, updates);

  const labels: Record<string, string> = {
    proposePaymentPlan: 'Payment plan saved',
    savePaymentPlan: 'Payment plan saved',
    proposeSchedule: 'Schedule saved',
    saveProjectSchedule: 'Schedule saved',
    proposePlan: 'Plan saved',
    draftInvoice: 'Invoice draft saved',
    draftContract: 'Contract draft saved',
    proposeChangeOrder: 'Change order saved',
    recordCostEntry: 'Cost entry recorded',
    fixCostEntry: 'Cost entry updated',
    logHours: 'Hours logged',
    correctTimesheet: 'Timesheet corrected',
    sendBuilderBrief: 'Builder brief sent and logged',
    sendContractorBrief: 'Contractor brief sent and logged',
    requestSitePhotos: 'Site photo request logged',
    relayCustomerUpdate: 'Customer update relayed',
    logBuilderReply: 'Builder reply logged',
    logBuilderPrice: 'Builder price logged',
    tagPhoto: 'Photo tagged',
    assessExtraFromPhotos: 'Extra assessment logged',
    assessProgress: 'Progress assessment logged',
    checkPaymentGate: 'Payment gate checked',
    notifyCustomerChangeOrder: 'Customer notified about change order',
  };

  return {
    ok: true,
    summary: labels[action] ?? `${action} applied to project ${projectId}.`,
    changeOrderId: createdChangeOrderId,
    output: { ...output, projectId, changeOrderId: createdChangeOrderId },
  };
}

export function approveChangeOrderServer(
  projectId: string,
  changeOrderId: string,
  approvedBy: string,
  approve: boolean,
): { ok: boolean; summary: string } {
  const project = getProjectById(projectId);
  if (!project) return { ok: false, summary: 'Project not found.' };
  const orders = Array.isArray(project.changeOrders) ? project.changeOrders as Array<Record<string, unknown>> : [];
  const idx = orders.findIndex((o) => String(o.id) === changeOrderId);
  if (idx < 0) return { ok: false, summary: 'Change order not found.' };
  const order = orders[idx];
  if (approve) {
    orders[idx] = {
      ...order,
      status: order.status === 'proposed' ? 'pending_customer' : 'approved',
      staffApprovedAt: new Date().toISOString(),
      staffApprovedBy: approvedBy,
      customerApprovedAt: order.status === 'pending_customer' ? new Date().toISOString() : order.customerApprovedAt,
    };
  } else {
    orders[idx] = { ...order, status: 'rejected', rejectedAt: new Date().toISOString(), rejectedBy: approvedBy };
  }
  updateProjectRecord(projectId, { changeOrders: orders });
  return {
    ok: true,
    summary: approve ? `Change order ${changeOrderId} approved.` : `Change order ${changeOrderId} rejected.`,
  };
}

export function completeHandoverServer(
  projectId: string,
  signedBy: string,
  customerNotes?: string,
): { ok: boolean; summary: string } {
  updateProjectRecord(projectId, {
    status: 'completed',
    handover: {
      signedAt: new Date().toISOString(),
      signedBy,
      customerNotes,
      retentionReleased: false,
    },
  });
  return { ok: true, summary: `Handover completed for project ${projectId}.` };
}

export function assignContractorServer(
  projectId: string,
  input: Record<string, unknown>,
): { ok: boolean; summary: string; contractorId?: string } {
  const project = getProjectById(projectId);
  if (!project) return { ok: false, summary: 'Project not found.' };
  const contractorId = firstString(input.contractorId) ?? `CTR${Date.now()}`;
  const name = firstString(input.name) ?? 'Contractor';
  const existing = Array.isArray(project.assignedContractors) ? project.assignedContractors as unknown[] : [];
  const next = [
    ...existing.filter((c) => String((c as Record<string, unknown>).id) !== contractorId),
    {
      id: contractorId,
      name,
      tradeId: firstString(input.tradeId),
      trade: firstString(input.trade, input.tradeId),
      contractorId,
    },
  ];
  updateProjectRecord(projectId, { assignedContractors: next });
  return { ok: true, summary: `Assigned ${name} to project.`, contractorId };
}

export function markPaymentReceivedServer(
  projectId: string,
  input: Record<string, unknown>,
): { ok: boolean; summary: string; stageId?: string } {
  const project = getProjectById(projectId);
  if (!project) return { ok: false, summary: 'Project not found.' };
  const stageId = firstString(input.stageId);
  const stageName = firstString(input.stageName)?.toLowerCase();
  const paidDate = firstString(input.paidDate) ?? new Date().toISOString().slice(0, 10);
  let matchedStageId: string | undefined;
  const stages = (Array.isArray(project.paymentStages) ? project.paymentStages as Array<Record<string, unknown>> : []).map((stage) => {
    const matchesId = stageId && String(stage.id) === stageId;
    const matchesName = stageName && String(stage.name ?? '').toLowerCase().includes(stageName);
    if (!matchesId && !matchesName) return stage;
    matchedStageId = String(stage.id);
    return { ...stage, status: 'paid', paidDate };
  });
  const matched = stages.some((s, i) => {
    const orig = (project.paymentStages as Array<Record<string, unknown>>)[i];
    return s !== orig;
  });
  if (!matched || !matchedStageId) return { ok: false, summary: 'Payment stage not found.' };
  updateProjectRecord(projectId, { paymentStages: stages });
  return { ok: true, summary: 'Payment marked received.', stageId: matchedStageId };
}
