/**
 * Standalone server for production deployment (Railway, Render, Fly.io).
 * Run: npx tsx server/index.ts
 */
import { createServer } from 'http';
import { handleAiRequest } from './ai-proxy';
import { handleWhatsAppRoutes } from './whatsapp-webhook';
import { handlePhoneRoutes } from './phone-webhook';
import { handleVapiRoutes } from './vapi-routes';
import { handleAgentRoutes } from './agent-routes';
import { handleProjectRoutes } from './project-routes';
import { handleBuildingControlRoutes } from './building-control-routes';
import { handleConversationAudit } from './conversation-audit';
import { handleAIStudioRoutes } from './ai-studio-routes';
import { handleBankingRoutes } from './banking-routes';
import { handleMessageRoutes } from './messages-routes';
import { handlePriceResearchRoutes } from './price-research-routes';
import { handleContractRoutes } from './contract-routes';
import { handlePlatformRoutes } from './platform-routes';
import { handleStripeRoutes } from './stripe-routes';
import { handleAuthRoutes } from './auth';
import { handleMailboxRoutes } from './mailbox-routes';
import { handlePackageUpdatesRoute } from './mailbox/package-updates';
import { handleLeadsRoutes } from './leads-routes';
import { handleOrgOpenAIKeyRoutes } from './org-openai-key-routes';
import { handleChannelRoutes } from './channel-routes';
import { handleAgentCredentialsRoutes } from './agent-credentials-routes';
import { initDataFromSupabase } from './data-store';

const PORT = Number(process.env.PORT) || 3001;
const ALLOWED_ORIGIN = process.env.APP_BASE_URL?.trim() || '*';

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Org-Id, X-User-Id, X-User-Role');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (await handleWhatsAppRoutes(req, res, pathname, url)) return;

    if (await handlePhoneRoutes(req, res, pathname, url)) return;

    if (await handleVapiRoutes(req, res, pathname)) return;

    if (await handleAgentRoutes(req, res, pathname, url)) return;

    if (await handleProjectRoutes(req, res, pathname)) return;

    if (await handleBuildingControlRoutes(req, res, pathname)) return;

    if (await handleAIStudioRoutes(req, res, pathname)) return;

    if (await handleConversationAudit(req, res, pathname)) return;

    if (await handleBankingRoutes(req, res, pathname, url)) return;

    if (await handleMailboxRoutes(req, res, pathname, url)) return;

    if (await handlePackageUpdatesRoute(pathname, res)) return;

    if (await handleMessageRoutes(req, res, pathname)) return;

    if (await handlePriceResearchRoutes(req, res, pathname)) return;

    if (await handleContractRoutes(req, res, pathname)) return;

    if (await handleStripeRoutes(req, res, pathname)) return;

    if (await handleAuthRoutes(req, res, pathname)) return;

    if (await handleOrgOpenAIKeyRoutes(req, res, pathname)) return;

    if (await handlePlatformRoutes(req, res, pathname)) return;

    if (await handleLeadsRoutes(req, res, pathname, url)) return;

    if (await handleChannelRoutes(req, res, pathname)) return;

    if (await handleAgentCredentialsRoutes(req, res, pathname)) return;

    if (pathname.startsWith('/api/ai/')) {
      await handleAiRequest(req, res, pathname);
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: err instanceof Error ? err.message : 'Internal server error',
      }));
    }
  }
});

server.listen(PORT, async () => {
  await initDataFromSupabase();
  console.log(`TradePro API server running on port ${PORT}`);
  void import('./code-fix-handler').then(({ startCodeFixWorker }) => startCodeFixWorker());
});
