import { createServer } from 'http';
import { handleSallyWebRoutes } from '../server/sally-web-routes.ts';

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (await handleSallyWebRoutes(req, res, url.pathname)) return;
  res.statusCode = 404;
  res.end('nf');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const res = await fetch(`http://127.0.0.1:${port}/api/sally/web`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text: 'What does Sync2Dine Judie cost per week? Keep it short.',
    sessionId: 'web_local_test1',
    page: '/',
  }),
});
const body = await res.text();
console.log('STATUS', res.status);
console.log(body.slice(0, 2000));
server.close();
process.exit(res.ok ? 0 : 2);
