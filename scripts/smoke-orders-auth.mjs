/**
 * Local smoke: anonymous GET /api/orders must 401 (SEC-001).
 * Run: node --import tsx scripts/smoke-orders-auth.mjs
 */
import http from 'http';
import { handleOrdersRoutes } from '../server/orders-routes.ts';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await handleOrdersRoutes(req, res, url.pathname);
  if (!handled) {
    res.statusCode = 404;
    res.end('no');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const r = await fetch(`http://127.0.0.1:${port}/api/orders`);
const text = await r.text();
console.log('anon GET /api/orders =>', r.status, text.slice(0, 160));
server.close();
if (r.status !== 401) {
  console.error('FAIL: expected 401');
  process.exit(1);
}
console.log('PASS SEC-001 local');
