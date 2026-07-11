export interface StaffPerformance {
  leads: number;
  quotes: number;
  won: number;
  lost: number;
  pending: number;
  revenue: number;
  conversionRate: number;
  avgDealSize: number;
}

export interface OfficeTeamMember {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'manager' | 'staff';
  department: string;
  performance: StaffPerformance;
}

/** Minimal office roster for server-side AI/orchestrator (no frontend testData dependency). */
const OFFICE_MANAGERS: OfficeTeamMember[] = [
  {
    id: 'M001',
    name: 'John Smith',
    email: 'john.smith@bathroompo.com',
    phone: '07700 700001',
    role: 'manager',
    department: 'Sales',
    performance: { leads: 45, quotes: 32, won: 18, lost: 8, pending: 6, revenue: 125000, conversionRate: 56.3, avgDealSize: 6944 },
  },
  {
    id: 'M002',
    name: 'Victoria Palmer',
    email: 'victoria.palmer@bathroompo.com',
    phone: '07700 700002',
    role: 'manager',
    department: 'Operations',
    performance: { leads: 28, quotes: 20, won: 12, lost: 5, pending: 3, revenue: 89000, conversionRate: 60.0, avgDealSize: 7417 },
  },
];

const OFFICE_SALES_STAFF: OfficeTeamMember[] = [
  {
    id: 'S001',
    name: 'Emily Roberts',
    email: 'emily.roberts@bathroompo.com',
    phone: '07700 800001',
    role: 'staff',
    department: 'Sales',
    performance: { leads: 42, quotes: 30, won: 16, lost: 8, pending: 6, revenue: 112000, conversionRate: 53.3, avgDealSize: 7000 },
  },
  {
    id: 'S002',
    name: 'Jack Thompson',
    email: 'jack.thompson@bathroompo.com',
    phone: '07700 800002',
    role: 'staff',
    department: 'Sales',
    performance: { leads: 38, quotes: 28, won: 15, lost: 9, pending: 4, revenue: 98000, conversionRate: 53.6, avgDealSize: 6533 },
  },
];

export function getOfficeTeamCounts() {
  return {
    managerCount: OFFICE_MANAGERS.length,
    salesStaffCount: OFFICE_SALES_STAFF.length,
    officeStaffCount: OFFICE_MANAGERS.length + OFFICE_SALES_STAFF.length,
  };
}

export function getOfficeTeamRoster(): OfficeTeamMember[] {
  return [...OFFICE_MANAGERS, ...OFFICE_SALES_STAFF];
}

export function getTopPerformer(): OfficeTeamMember | undefined {
  const roster = getOfficeTeamRoster();
  return [...roster].sort((a, b) => b.performance.revenue - a.performance.revenue)[0];
}
