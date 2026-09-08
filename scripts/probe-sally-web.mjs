#!/usr/bin/env node
/**
 * Probe Sally web chat against a base URL (default live app).
 * Usage: node scripts/probe-sally-web.mjs [baseUrl]
 */
const base = (process.argv[2] || 'https://app.sync2dine.io').replace(/\/$/, '');
const body = {
  text: 'What does Sync2Dine Judie cost per week? Keep the answer short.',
  sessionId: `web_probe_${Date.now().toString(36)}`,
  page: '/',
};

const res = await fetch(`${base}/api/sally/web`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log('STATUS', res.status);
console.log(text.slice(0, 3000));
process.exit(res.ok ? 0 : 1);
