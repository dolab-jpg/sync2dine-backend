import type { IncomingMessage, ServerResponse } from 'http';
import { getDataStore, syncData, getProjectById, saveWhatsAppGroup, setRequestOrgId } from './data-store';
import { isAuthEnforced, requireAuth, resolveOrgIdForRequest } from './auth';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function handleProjectRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname === '/api/project-deposit-checkout' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req)) as {
        amount?: number;
        projectId?: string;
        stageId?: string;
        portalToken?: string;
      };
      const amount = Number(body.amount) || 0;
      if (amount <= 0) {
        sendJson(res, 400, { error: 'Invalid deposit amount' });
        return true;
      }
      const secret = process.env.STRIPE_SECRET_KEY;
      if (!secret) {
        sendJson(res, 501, { error: 'Stripe customer checkout not configured' });
        return true;
      }
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(secret);
      const origin = process.env.APP_BASE_URL ?? 'http://localhost:5174';
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'gbp',
              unit_amount: Math.round(amount * 100),
              product_data: {
                name: 'Booking deposit',
                description: body.projectId ? `Project ${body.projectId}` : 'TradePro deposit',
              },
            },
          },
        ],
        success_url: body.portalToken
          ? `${origin}/portal/${body.portalToken}?deposit=paid`
          : `${origin}/?deposit=paid`,
        cancel_url: body.portalToken
          ? `${origin}/portal/${body.portalToken}?deposit=cancelled`
          : `${origin}/`,
        metadata: {
          projectId: body.projectId ?? '',
          stageId: body.stageId ?? '',
          kind: 'customer_deposit',
        },
      });
      if (!session.url) {
        sendJson(res, 500, { error: 'Stripe did not return a checkout URL' });
        return true;
      }
      sendJson(res, 200, { url: session.url });
      return true;
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Checkout failed' });
      return true;
    }
  }

  if (pathname === '/api/data/sync' && req.method === 'POST') {
    if (isAuthEnforced() && !requireAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const body = JSON.parse(await readBody(req));
    const orgId = resolveOrgIdForRequest(req, body) ?? 'default';

    setRequestOrgId(orgId);
    const payload = {
        projects: body.projects ?? [],
        contacts: body.contacts ?? [],
        builders: body.builders ?? [],
        sessions: body.sessions ?? [],
        recruitmentJobs: body.recruitmentJobs,
        recruitmentCandidates: body.recruitmentCandidates,
        recruitmentInterviews: body.recruitmentInterviews,
        customers: body.customers,
        calls: body.calls,
        outboundQueue: body.outboundQueue,
      };
      const store = getDataStore(orgId);
      syncData({
        ...store,
        ...(body.recruitmentJobs ? { recruitmentJobs: body.recruitmentJobs } : {}),
        ...(body.recruitmentCandidates ? { recruitmentCandidates: body.recruitmentCandidates } : {}),
        ...(body.recruitmentInterviews ? { recruitmentInterviews: body.recruitmentInterviews } : {}),
        ...(body.customers ? { customers: body.customers } : {}),
        ...(body.projects ? { projects: body.projects } : {}),
        ...(body.contacts ? { contacts: body.contacts } : {}),
        ...(body.builders ? { builders: body.builders } : {}),
        ...(body.sessions ? { sessions: body.sessions } : {}),
        ...(body.bankAccounts ? { bankAccounts: body.bankAccounts } : {}),
        ...(body.bankTransactions ? { bankTransactions: body.bankTransactions } : {}),
        ...(body.clientReceipts ? { clientReceipts: body.clientReceipts } : {}),
        ...(body.quotes ? { quotes: body.quotes } : {}),
        ...(body.planningApplications ? { planningApplications: body.planningApplications } : {}),
      }, orgId);

    sendJson(res, 200, {
      success: true,
      orgId,
      deprecated: true,
      message: 'Use Supabase client directly — this endpoint is deprecated',
    });
    return true;
  }

  if (pathname === '/api/files/upload' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const store = getDataStore();
    const project = store.projects.find(p => String(p.id) === body.projectId);
    if (project) {
      const files = [...(project.files as unknown[] ?? []), body.file];
      project.files = files;
      if (body.file?.mimeType?.startsWith('image/')) {
        project.photos = [...(project.photos as string[] ?? []), body.file.id];
      }
      syncData(store);
    }
    sendJson(res, 200, { success: true, file: body.file });
    return true;
  }

  const portalMatch = pathname.match(/^\/api\/portal\/([^/]+)$/);
  if (portalMatch && req.method === 'GET') {
    const token = portalMatch[1];
    const project = getDataStore().projects.find(p => p.portalToken === token);
    if (!project) {
      sendJson(res, 404, { error: 'Invalid or expired portal link' });
      return true;
    }
    const safe = filterProjectForPortal(project);
    sendJson(res, 200, safe);
    return true;
  }

  const groupCreateMatch = pathname.match(/^\/api\/projects\/([^/]+)\/whatsapp-group$/);
  if (groupCreateMatch && req.method === 'POST') {
    const projectId = groupCreateMatch[1];
    const project = getProjectById(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const body = JSON.parse(await readBody(req));
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const subject = body.subject ?? `${project.projectName ?? 'Project'} Group`;

    if (accessToken && phoneNumberId) {
      try {
        const createRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/groups`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            subject,
            description: body.description ?? `Project group for ${project.customerName}`,
          }),
        });
        const data = await createRes.json() as { id?: string; invite_link?: string };
        if (data.id) {
          const group = {
            metaGroupId: data.id,
            inviteLink: data.invite_link ?? '',
            subject,
            status: 'created',
            participantCount: 1,
            createdAt: new Date().toISOString(),
          };
          saveWhatsAppGroup(projectId, group);
          sendJson(res, 200, { success: true, group });
          return true;
        }
      } catch {
        // fall through to mock
      }
    }

    const mockGroup = {
      metaGroupId: `mock_grp_${Date.now()}`,
      inviteLink: `https://wa.me/g/mock_${projectId}`,
      subject,
      status: 'created',
      participantCount: 1,
      createdAt: new Date().toISOString(),
    };
    saveWhatsAppGroup(projectId, mockGroup);
    sendJson(res, 200, { success: true, group: mockGroup, mock: true });
    return true;
  }

  if (groupCreateMatch && req.method === 'GET') {
    const projectId = groupCreateMatch[1];
    const group = getDataStore().whatsappGroups[projectId];
    sendJson(res, 200, { group: group ?? null });
    return true;
  }

  const groupInviteMatch = pathname.match(/^\/api\/projects\/([^/]+)\/whatsapp-group\/invite$/);
  if (groupInviteMatch && req.method === 'POST') {
    const projectId = groupInviteMatch[1];
    const group = getDataStore().whatsappGroups[projectId];
    if (!group) {
      sendJson(res, 404, { error: 'No group for this project' });
      return true;
    }
    sendJson(res, 200, {
      success: true,
      inviteLink: group.inviteLink,
      message: 'Invite link ready — send via template to selected contacts',
    });
    return true;
  }

  return false;
}

function filterProjectForPortal(project: Record<string, unknown>) {
  return {
    id: project.id,
    projectName: project.projectName,
    customerName: project.customerName,
    status: project.status,
    startDate: project.startDate,
    finishDate: project.finishDate,
    description: project.description,
    totalCustomerCost: project.totalCustomerCost,
    tasks: (project.tasks as unknown[] ?? []).map((t: Record<string, unknown>) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      targetDate: t.targetDate,
    })),
    milestones: project.milestones,
    paymentStages: (project.paymentStages as unknown[] ?? []).map((s: Record<string, unknown>) => ({
      id: s.id,
      name: s.name,
      amount: s.amount,
      status: s.status,
      dueDate: s.dueDate,
    })),
    messages: project.messages,
    changeOrders: (project.changeOrders as unknown[] ?? []).map((order: Record<string, unknown>) => {
      const status = String(order.status ?? 'proposed');
      const isVisibleToCustomer = status !== 'proposed';
      return {
        id: order.id,
        title: order.title,
        description: order.description,
        reason: order.reason,
        estimatedDays: order.estimatedDays,
        createdAt: order.createdAt,
        status,
        amount: isVisibleToCustomer ? Number(order.amount ?? 0) : 0,
        amountMin: isVisibleToCustomer ? order.amountMin : undefined,
        amountMax: isVisibleToCustomer ? order.amountMax : undefined,
      };
    }),
    files: (project.files as unknown[] ?? []).map((f: Record<string, unknown>) => ({
      id: f.id,
      filename: f.filename,
      mimeType: f.mimeType,
      source: f.source,
      takenAt: f.takenAt,
      dataUrl: f.dataUrl,
    })),
    photos: project.photos,
  };
}
