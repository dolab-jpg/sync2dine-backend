import { BDIDDIES_COMPANY } from './home-org';

/** Sync2Dine footer lines for invoice / receipt emails. */
export function buildSync2DineEmailFooter(company?: {
  companyName?: string;
  website?: string;
  email?: string;
  phone?: string;
}): string {
  const name = company?.companyName?.trim() || BDIDDIES_COMPANY.companyName;
  const website = company?.website?.trim() || BDIDDIES_COMPANY.website;
  const email = company?.email?.trim() || BDIDDIES_COMPANY.email;
  const phone = company?.phone?.trim() || BDIDDIES_COMPANY.phone;
  return [
    '',
    '—',
    name,
    website,
    email,
    phone,
  ].filter(Boolean).join('\n');
}

export function appendSync2DineEmailFooter(
  body: string,
  company?: Parameters<typeof buildSync2DineEmailFooter>[0],
): string {
  const trimmed = (body ?? '').trimEnd();
  if (trimmed.includes(BDIDDIES_COMPANY.website) || trimmed.includes('— Sync2Dine')) {
    return trimmed;
  }
  return `${trimmed}${buildSync2DineEmailFooter(company)}`;
}
