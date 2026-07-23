/**
 * Proves production boot fails closed without JWT_SECRET.
 * Spawns a tiny loader that only runs assertJwtSecretForBoot — not the full server.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = `
import { assertJwtSecretForBoot } from './server/jwt-secret.ts';
assertJwtSecretForBoot();
console.log('UNEXPECTED_BOOT_OK');
`;

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '-e', code],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JWT_SECRET: '',
    },
    encoding: 'utf8',
  },
);

if (result.status === 0 || (result.stdout || '').includes('UNEXPECTED_BOOT_OK')) {
  console.error('FAIL: production boot unexpectedly succeeded without JWT_SECRET');
  console.error(result.stdout);
  process.exit(1);
}

const err = `${result.stderr || ''}${result.stdout || ''}`;
if (!/JWT_SECRET is required/i.test(err)) {
  console.error('FAIL: expected JWT_SECRET required error, got:');
  console.error(err);
  process.exit(1);
}

console.log('OK: production boot fails closed without JWT_SECRET');
