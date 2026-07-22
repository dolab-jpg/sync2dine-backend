import { renameSync, existsSync } from 'fs';
import { join } from 'path';
import { hydrateStripeFromPlatformOwner, getStripeRuntimeConfig } from '../server/stripe-config';

const file = join(process.cwd(), 'server', 'data', 'integration-secrets.json');
const bak = `${file}.bak-verify`;

async function main() {
  if (existsSync(file)) renameSync(file, bak);
  try {
    const before = getStripeRuntimeConfig();
    const after = await hydrateStripeFromPlatformOwner();
    const data = {
      beforeSource: before.source,
      beforeHas: Boolean(before.secretKey),
      afterSource: after.source,
      afterHas: Boolean(after.secretKey),
      prefix: (after.secretKey || '').slice(0, 7),
      restoredFile: existsSync(file),
    };
    console.log(JSON.stringify(data, null, 2));
    if (!after.secretKey) process.exit(1);
  } finally {
    if (existsSync(bak) && existsSync(file)) {
      try { renameSync(bak, `${bak}.discard`); } catch { /* ignore */ }
    } else if (existsSync(bak) && !existsSync(file)) {
      renameSync(bak, file);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
