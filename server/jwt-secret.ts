/**
 * JWT secret resolution with production fail-closed behaviour.
 * Known development fallbacks must never be used when NODE_ENV/SYNC2DINE_ENV is production.
 */

export const KNOWN_DEV_JWT_SECRETS = [
  'tradepro-dev-jwt-secret-change-in-production',
  'sync2dine-dev-jwt-secret-change-in-production',
] as const;

export function isProductionRuntime(): boolean {
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  const syncEnv = (process.env.SYNC2DINE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'production' || syncEnv === 'production') return true;
  if (process.env.FAIL_CLOSED === '1' || process.env.FAIL_CLOSED === 'true') return true;
  return false;
}

export function isKnownDevJwtSecret(secret: string | null | undefined): boolean {
  const value = secret?.trim() || '';
  if (!value) return false;
  return (KNOWN_DEV_JWT_SECRETS as readonly string[]).includes(value);
}

/**
 * Resolve the JWT signing secret.
 * - Production: missing or known-dev secret throws.
 * - Development: missing secret uses an explicit known-dev fallback.
 */
export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET?.trim() || '';
  const production = (() => {
    const nodeEnv = (env.NODE_ENV || '').trim().toLowerCase();
    const syncEnv = (env.SYNC2DINE_ENV || '').trim().toLowerCase();
    if (nodeEnv === 'production' || syncEnv === 'production') return true;
    if (env.FAIL_CLOSED === '1' || env.FAIL_CLOSED === 'true') return true;
    return false;
  })();

  if (production) {
    if (!secret) {
      throw new Error(
        'JWT_SECRET is required in production. Refusing to boot with an empty or missing secret.',
      );
    }
    if (isKnownDevJwtSecret(secret)) {
      throw new Error(
        'JWT_SECRET is set to a known development fallback. Refusing to boot in production.',
      );
    }
    return secret;
  }

  if (!secret) {
    return KNOWN_DEV_JWT_SECRETS[0];
  }
  return secret;
}

/** Call once at process boot before accepting traffic. */
export function assertJwtSecretForBoot(env: NodeJS.ProcessEnv = process.env): void {
  resolveJwtSecret(env);
}
