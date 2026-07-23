/** Sally sales � implementation in ./sally/ */
export {
  SALLY_PERSONA,
  SALLY_EXCLUSIVE_TOOLS,
  getSallyOfferTerms,
  resolveSallySessionKey,
  isSallySalesCall,
  getSallyDraftForSession,
  getSallyTermsForSession,
  buildSallyCheckoutHandoff,
} from './sally/offer';
export type { SallyOfferTerms, SallyTermsRecord } from './sally/offer';
export {
  SALLY_PHONE_TOOLS,
  SALLY_EXTENDED_TOOLS,
  getSallyPhoneSessionChatTools,
  getSallyOrchestratorTools,
  getSallyWebOrchestratorTools,
  isSallyToolName,
  isSallyExclusiveTool,
} from './sally/tools';
export {
  buildSallyBrainPrompt,
  buildSallyChatPrompt,
  buildSallyWebPrompt,
} from './sally/prompts';
export { executeSallyTool, enqueueSallyRetryLeads } from './sally/execute';
export type { SallyToolContext } from './sally/execute';
