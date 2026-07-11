import { getDataStore, normalizePhoneExport, resolveContactByPhone } from './data-store';
import { listTeamMembers } from './conversation-store';

export type ChannelRouteMode = 'staff' | 'foreman' | 'customer' | 'unknown';

export interface ChannelRoute {
  mode: ChannelRouteMode;
  role?: string;
  userId?: string;
  name?: string;
  builderId?: string;
  customerId?: string | null;
  customerName?: string;
  contactName?: string;
  projectId?: string | null;
  preferredLanguage?: string | null;
}

export function resolveInboundChannel(phone: string, orgId?: string): ChannelRoute {
  const normalized = normalizePhoneExport(phone);
  const members = listTeamMembers(orgId);
  const staffMatch = members.find((m) => normalizePhoneExport(m.phone) === normalized);
  if (staffMatch) {
    return {
      mode: 'staff',
      role: staffMatch.role,
      userId: staffMatch.userId,
      name: staffMatch.name,
    };
  }

  const store = getDataStore(orgId);
  const builderMatch = (store.builders ?? []).find(
    (b) => normalizePhoneExport(String(b.phone ?? '')) === normalized
  );
  if (builderMatch) {
    const activeProject = store.projects.find((p) => {
      const status = String(p.status ?? '');
      if (status === 'completed' || status === 'cancelled') return false;
      return String(p.assignedBuilder ?? '').trim() === String(builderMatch.name ?? '').trim();
    });
    return {
      mode: 'foreman',
      role: 'builder',
      builderId: String(builderMatch.id ?? ''),
      name: String(builderMatch.name ?? builderMatch.companyName ?? 'Builder'),
      projectId: activeProject ? String(activeProject.id) : null,
    };
  }

  for (const project of store.projects) {
    const status = String(project.status ?? '');
    if (status === 'completed' || status === 'cancelled') continue;
    const assignedBuilder = String(project.assignedBuilder ?? '').trim();
    if (!assignedBuilder) continue;
    const match = (store.builders ?? []).find((builder) =>
      String(builder.name ?? '').trim() === assignedBuilder
      && normalizePhoneExport(String(builder.phone ?? '')) === normalized
    );
    if (match) {
      return {
        mode: 'foreman',
        role: 'builder',
        builderId: String(match.id ?? ''),
        name: assignedBuilder,
        projectId: String(project.id),
      };
    }
  }

  const contact = resolveContactByPhone(phone);
  if (contact.customerId) {
    const customer = store.customers.find((c) => String(c.id) === contact.customerId);
    return {
      mode: 'customer',
      role: 'customer',
      customerId: contact.customerId,
      customerName: contact.customerName,
      contactName: contact.contactName,
      projectId: contact.projectId,
      preferredLanguage: customer?.preferredLanguage ? String(customer.preferredLanguage) : null,
    };
  }

  return { mode: 'unknown', name: 'Guest' };
}
