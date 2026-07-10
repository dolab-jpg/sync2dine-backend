import { testManagers, testSalesStaff } from '../src/app/data/testData';

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

/** Office team counts aligned with src/app/data/testData.ts (testManagers + testSalesStaff). */
export function getOfficeTeamCounts() {
  const managerCount = testManagers.length;
  const salesStaffCount = testSalesStaff.length;
  return {
    managerCount,
    salesStaffCount,
    officeStaffCount: managerCount + salesStaffCount,
  };
}

export function getOfficeTeamRoster(): OfficeTeamMember[] {
  const mapMember = (
    m: (typeof testManagers)[0] | (typeof testSalesStaff)[0],
    role: 'manager' | 'staff',
  ): OfficeTeamMember => ({
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    role,
    department: m.department,
    performance: (m as { performance?: StaffPerformance }).performance ?? {
      leads: 0,
      quotes: 0,
      won: 0,
      lost: 0,
      pending: 0,
      revenue: 0,
      conversionRate: 0,
      avgDealSize: 0,
    },
  });

  return [
    ...testManagers.map((m) => mapMember(m, 'manager')),
    ...testSalesStaff.map((m) => mapMember(m, 'staff')),
  ];
}

export function getTopPerformer(): OfficeTeamMember | undefined {
  const roster = getOfficeTeamRoster();
  return [...roster].sort((a, b) => b.performance.revenue - a.performance.revenue)[0];
}
