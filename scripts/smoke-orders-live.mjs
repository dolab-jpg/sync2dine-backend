#!/usr/bin/env node
/**
 * Live smoke: orders API should reject unauthenticated requests (401).
 * Usage: node scripts/smoke-orders-live.mjs [baseUrl]
 */
const base = (process.argv[2] || 'https://app.sync2dine.io').replace(/\/$/, '');
const res = await fetch(`${base}/api/orders`);
const code = res.status;
console.log('STATUS', code, await res.text().then((t) => t.slice(0, 200)));
if (code === 401 || code === 403) {
  process.exit(0);
}
console.error('Expected 401/403 from /api/orders without auth');
process.exit(1);
