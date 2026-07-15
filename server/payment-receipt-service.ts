/**
 * Server-side payment receipt PDF + email (WhatsApp / channel path).
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { getDataStore, getProjectById, syncData, updateProjectRecord } from './data-store.js';
import { sendViaSmtp } from './messages-routes.js';
import { getSupabaseAdmin, resolveOrgUuid } from './supabase-admin.js';

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

async function loadCompanyProfile(): Promise<Record<string, string>> {
  try {
    const supabase = getSupabaseAdmin();
    const orgUuid = await resolveOrgUuid();
    const { data } = await supabase
      .from('integrations')
      .select('values_encrypted')
      .eq('org_id', orgUuid)
      .eq('integration_id', 'company')
      .maybeSingle();
    return (data?.values_encrypted ?? {}) as Record<string, string>;
  } catch {
    return { autoSendReceiptOnPaid: 'true', companyName: 'TradePro Ltd' };
  }
}

export function isAutoSendReceiptOnPaid(company: Record<string, string>): boolean {
  return company.autoSendReceiptOnPaid !== 'false';
}

function hasReceiptForStage(projectId: string, stageId: string): boolean {
  const store = getDataStore();
  return store.clientReceipts.some(
    (r) => String(r.projectId) === projectId && String(r.stageId) === stageId && Boolean(r.sentAt)
  );
}

async function buildReceiptPdfBytes(
  company: Record<string, string>,
  customerName: string,
  projectName: string,
  amount: number,
  stageName: string,
  receiptId: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  const { height } = page.getSize();
  let y = height - 48;

  const companyName = company.companyName?.trim() || 'TradePro Ltd';
  page.drawText(companyName, { x: 48, y, size: 14, font: bold, color: rgb(0.1, 0.1, 0.2) });
  y -= 28;
  page.drawText('PAYMENT RECEIPT', { x: 48, y, size: 18, font: bold, color: rgb(0.1, 0.1, 0.2) });
  y -= 24;

  const sections = [
    { heading: 'Received From', lines: [customerName] },
    {
      heading: 'Payment Details',
      lines: [
        `Project: ${projectName}`,
        `Stage: ${stageName}`,
        `Amount: £${amount.toFixed(2)} (GBP)`,
        `Date: ${new Date().toLocaleDateString('en-GB')}`,
        `Reference: ${receiptId}`,
      ],
    },
    { heading: 'Confirmation', lines: ['Thank you for your payment. Please retain this receipt for your records.'] },
  ];

  for (const section of sections) {
    page.drawText(section.heading, { x: 48, y, size: 12, font: bold, color: rgb(0.15, 0.35, 0.55) });
    y -= 16;
    for (const line of section.lines) {
      page.drawText(line, { x: 56, y, size: 10, font, color: rgb(0.15, 0.15, 0.2) });
      y -= 14;
    }
    y -= 10;
  }

  const footer: string[] = [];
  if (company.website?.trim()) footer.push(company.website.trim());
  if (company.companyRegistrationNumber?.trim()) {
    footer.push(`Company reg. no. ${company.companyRegistrationNumber.trim()}`);
  }
  let fy = 52;
  for (const line of footer) {
    page.drawText(line, { x: 48, y: fy, size: 8, font, color: rgb(0.45, 0.45, 0.5) });
    fy += 11;
  }

  return doc.save();
}

function resolveStage(
  project: Record<string, unknown>,
  stageId?: string,
  stageName?: string
): Record<string, unknown> | undefined {
  const stages = Array.isArray(project.paymentStages)
    ? project.paymentStages as Array<Record<string, unknown>>
    : [];
  const nameLower = stageName?.toLowerCase();
  return stages.find((s) => {
    if (stageId && String(s.id) === stageId) return true;
    if (nameLower && String(s.name ?? '').toLowerCase().includes(nameLower)) return true;
    return false;
  });
}

export async function sendReceiptForStageServer(
  projectId: string,
  input: Record<string, unknown>,
  options?: { force?: boolean }
): Promise<{ ok: boolean; summary: string; skipped?: boolean }> {
  const project = getProjectById(projectId);
  if (!project) return { ok: false, summary: 'Project not found.' };

  const stageId = firstString(input.stageId);
  const stageName = firstString(input.stageName);
  const stage = resolveStage(project, stageId, stageName);
  if (!stage) return { ok: false, summary: 'Payment stage not found.' };

  const resolvedStageId = String(stage.id);
  if (String(stage.status) !== 'paid') {
    return { ok: false, summary: `Stage "${String(stage.name)}" is not marked paid.` };
  }

  if (!options?.force && hasReceiptForStage(projectId, resolvedStageId)) {
    return { ok: true, summary: 'Receipt already sent for this stage.', skipped: true };
  }

  const customerId = firstString(project.customerId, input.customerId);
  const store = getDataStore();
  const customer = store.customers.find((c) => String(c.id) === customerId);
  const customerName = firstString(customer?.name, project.customerName) ?? 'Customer';
  const customerEmail = firstString(customer?.email, project.customerEmail);
  if (!customerEmail) return { ok: false, summary: 'Customer email not found.' };

  const company = await loadCompanyProfile();
  const projectName = firstString(project.projectName, project.description, customerName) ?? 'Project';
  const amount = Number(stage.amount ?? 0);
  const stageLabel = String(stage.name ?? 'Payment');
  const receiptId = `RCP-${Date.now()}`;
  const pdfBytes = await buildReceiptPdfBytes(company, customerName, projectName, amount, stageLabel, receiptId);
  const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
  const filename = `receipt-${receiptId}.pdf`;

  const sendResult = await sendViaSmtp(
    {
      subject: `Payment receipt — ${stageLabel}`,
      body: `Thank you for your payment of £${amount.toFixed(2)} for ${stageLabel}.`,
      attachment: { filename, mimeType: 'application/pdf', content: pdfBase64 },
    },
    customerEmail
  );

  const receipt = {
    id: receiptId,
    customerId: customerId ?? '',
    customerName,
    projectId,
    projectName,
    stageId: resolvedStageId,
    amount,
    date: firstString(stage.paidDate) ?? new Date().toISOString().slice(0, 10),
    pdfPath: filename,
    sentVia: 'email',
    sentAt: sendResult.success ? new Date().toISOString() : undefined,
    createdAt: new Date().toISOString(),
  };
  store.clientReceipts.unshift(receipt);
  syncData(store);

  const invoices = Array.isArray(project.invoices) ? [...(project.invoices as unknown[])] : [];
  const invIdx = invoices.findIndex((inv) => String((inv as Record<string, unknown>).stageId) === resolvedStageId);
  if (invIdx >= 0) {
    invoices[invIdx] = { ...(invoices[invIdx] as Record<string, unknown>), status: 'paid' };
    updateProjectRecord(projectId, { invoices });
  }

  if (!sendResult.success) {
    return { ok: false, summary: sendResult.error ?? 'Receipt saved but email failed.' };
  }
  return { ok: true, summary: `Receipt emailed to ${customerName} for ${stageLabel}.` };
}

export async function autoSendReceiptAfterMarkPaidServer(
  projectId: string,
  stageId: string
): Promise<{ ok: boolean; summary: string; skipped?: boolean } | null> {
  const company = await loadCompanyProfile();
  if (!isAutoSendReceiptOnPaid(company)) return null;
  return sendReceiptForStageServer(projectId, { stageId }, { force: false });
}
