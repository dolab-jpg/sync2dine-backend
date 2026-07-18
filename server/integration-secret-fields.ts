/**
 * Field keys that must be encrypted at rest in integrations.values_encrypted.
 * Keep aligned with password fields in src/app/config/integrations/registry.ts.
 */
export const INTEGRATION_SECRET_FIELD_KEYS = new Set([
  'apiKey',
  'deepseekApiKey',
  'password',
  'googleClientSecret',
  'microsoftClientSecret',
  'yahooClientSecret',
  'anonKey',
  'serviceRoleKey',
  'secretKey',
  'webhookSecret',
  'clientSecret',
  'authToken',
  'sipPassword',
  'privateKey',
  'serverSecret',
  'accessKey',
  'accessToken',
]);

export function isSecretFieldKey(key: string): boolean {
  return INTEGRATION_SECRET_FIELD_KEYS.has(key);
}

export function isMaskedOrPlaceholder(value: string | undefined): boolean {
  const v = value?.trim() ?? '';
  if (!v) return true;
  if (v.startsWith('••••')) return true;
  if (v === '(configured on server)') return true;
  return false;
}

export function maskSecretHint(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}
