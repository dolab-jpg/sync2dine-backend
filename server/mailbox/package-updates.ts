import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const TRACKED = [
  { package: 'imapflow', githubRepo: 'postalsys/imapflow' },
  { package: 'mailparser', githubRepo: 'nodemailer/mailparser' },
  { package: 'google-auth-library', githubRepo: 'googleapis/google-auth-library-nodejs' },
  { package: '@azure/msal-node', githubRepo: 'AzureAD/microsoft-authentication-library-for-js' },
  { package: 'nodemailer', githubRepo: 'nodemailer/nodemailer' },
];

function readInstalledVersion(pkg: string): string | null {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    const json = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const v = json.dependencies?.[pkg];
    return v?.replace(/^\^/, '') ?? null;
  } catch {
    return null;
  }
}

function fetchLatestVersion(pkg: string): string | null {
  try {
    const out = execSync(`npm view ${pkg} version`, { encoding: 'utf8', timeout: 15000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function getPackageUpdates() {
  return TRACKED.map(({ package: pkg, githubRepo }) => {
    const installed = readInstalledVersion(pkg);
    const latest = fetchLatestVersion(pkg);
    return {
      package: pkg,
      githubRepo,
      installed,
      latest,
      updateAvailable: Boolean(installed && latest && installed !== latest),
      releasesUrl: `https://github.com/${githubRepo}/releases`,
    };
  });
}

export async function handlePackageUpdatesRoute(
  pathname: string,
  res: import('http').ServerResponse
): Promise<boolean> {
  if (pathname !== '/api/integrations/package-updates') return false;
  const updates = getPackageUpdates();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ checkedAt: new Date().toISOString(), updates }));
  return true;
}
