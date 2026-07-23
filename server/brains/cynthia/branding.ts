/** Builder Diddies branding for the Cynthia construction phone brain only. */
export const BUILDER_DIDDIES_COMPANY = {
  companyName: 'Builder Diddies',
  assistantName: 'Cynthia',
  website: 'https://b-diddies.com',
  email: 'info@b-diddies.com',
} as const;

export const CYNTHIA_PERSONA = 'cynthia';

/** Retarget Sync2Dine/Judie copy from phone-brain for this brain only. */
export function brandPhonePromptAsCynthia(text: string): string {
  return text
    .replace(/\bJudie\b/g, BUILDER_DIDDIES_COMPANY.assistantName)
    .replace(/\bSync2Dine\b/g, BUILDER_DIDDIES_COMPANY.companyName)
    .replace(/\bJudie's\b/g, "Cynthia's");
}
