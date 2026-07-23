#!/usr/bin/env node
/**
 * Probe Sally web chat against a base URL (default local VPS 3011).
 * Usage: node scripts/probe-sally-web.mjs [baseUrl]
 */
const base = (process.argv[2] || 'http://127.0.0.1:3011').replace(/\/$/, '');
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
