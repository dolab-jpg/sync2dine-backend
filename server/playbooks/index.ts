import { bathroomPlaybook } from './bathroom';
import { kitchenPlaybook } from './kitchen';
import { electricalPlaybook } from './electrical';

export type PlaybookTradeId = 'bathroom' | 'kitchen' | 'electrical';

export interface TradePlaybook {
  phases: readonly string[];
  complianceNotes: readonly string[];
  snagChecklist: readonly string[];
  commonExtras: readonly string[];
}

const PLAYBOOKS: Record<PlaybookTradeId, TradePlaybook> = {
  bathroom: bathroomPlaybook,
  kitchen: kitchenPlaybook,
  electrical: electricalPlaybook,
};

function isPlaybookTradeId(tradeId: string): tradeId is PlaybookTradeId {
  return tradeId in PLAYBOOKS;
}

export function getPlaybook(tradeId: string): TradePlaybook | undefined {
  if (!isPlaybookTradeId(tradeId)) return undefined;
  return PLAYBOOKS[tradeId];
}

export { bathroomPlaybook, PLAYBOOKS };
