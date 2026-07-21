import { getHomeOrgId } from '../home-org';
import { listActiveSnippets } from './store';

/** Tiny approved playbook block for live prompt — never slows with LLM. */
export function buildApprovedSalesBrainPromptBlock(orgId?: string | null): string {
  const id = orgId || getHomeOrgId();
  const body = listActiveSnippets(id, 800);
  // #region agent log
  void import('../debug-session-log').then(({ debugLog }) => {
    debugLog('C', 'sales-brain/inject.ts', 'inject block', {
      orgId: id,
      bodyLen: body.length,
      hasBlock: Boolean(body),
    }, 'verify-all');
  }).catch(() => {});
  // #endregion
  if (!body) return '';
  return [
    'APPROVED SALES BRAIN NOTES (follow; do not invent prices or promises):',
    body,
  ].join('\n');
}
