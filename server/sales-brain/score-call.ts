import { getCallById } from '../data-store';
import { getHomeOrgId } from '../home-org';
import { normalizeObjection, type ObjectionCode, type SalesOutcome } from './taxonomy';
import type { SalesCallInsight } from './store';
import { newSalesBrainId } from './store';

function turnsText(callId: string): { text: string; durationSec?: number; meta: Record<string, unknown> } {
  const call = getCallById(callId);
  const turns = Array.isArray(call?.transcript) ? call!.transcript : [];
  const text = turns
    .map((t) => `${(t as { role?: string }).role || '?'}: ${String((t as { content?: string }).content || '')}`)
    .join('\n')
    .slice(0, 12000);
  const meta = (call?.metadata && typeof call.metadata === 'object')
    ? (call.metadata as Record<string, unknown>)
    : {};
  return {
    text,
    durationSec: typeof call?.durationSec === 'number' ? call.durationSec : undefined,
    meta,
  };
}

function heuristicScore(
  callId: string,
  orgId: string,
  persona?: string,
  aim?: string | null,
): SalesCallInsight {
  const { text, durationSec, meta } = turnsText(callId);
  const lower = text.toLowerCase();
  const objections: ObjectionCode[] = [];
  for (const phrase of [
    'too expensive', 'think about it', 'send me', 'already have', 'no budget',
    'call me later', 'not interested', 'busy', 'need approval', 'demo',
  ]) {
    if (lower.includes(phrase.split(' ')[0]!) || lower.includes(phrase)) {
      objections.push(normalizeObjection(phrase));
    }
  }
  const uniq = [...new Set(objections)].slice(0, 6);
  let outcome: SalesOutcome = 'other';
  if (/bookIntegrationMeeting|meeting booked|install chat|twenty-minute|20-min/i.test(text)
    || /meeting/.test(String(meta.aim || aim || ''))) {
    outcome = /book|booked|scheduled/.test(lower) ? 'meeting_booked' : outcome;
  }
  if (/callback|call back|ring you/.test(lower)) outcome = outcome === 'other' ? 'callback' : outcome;
  if (/do not call|remove|stop calling/.test(lower)) outcome = 'dnc';
  if (/no-answer|voicemail|did not answer/.test(String(meta.disposition || meta.vapiEndedReason || ''))) {
    outcome = 'no_answer';
  }

  const hasDiscovery = /missed call|atmosphere|busy|hours|owner|manager/.test(lower);
  const hasClose = /meeting|book|install|integration/.test(lower);
  const hasValue = /revenue|save|staff|orders|return/.test(lower);

  return {
    id: newSalesBrainId(),
    orgId,
    callId,
    agentPersona: persona,
    aim: aim ?? (meta.aim != null ? String(meta.aim) : null),
    durationSec,
    reachedDm: /owner|manager|director|decision/.test(lower) ? 'likely' : 'unknown',
    rapportScore: /cheers|lovely|laugh|sorted/.test(lower) ? 4 : 3,
    discoveryScore: hasDiscovery ? 4 : 2,
    valueScore: hasValue ? 4 : 2,
    closeScore: hasClose ? 4 : 2,
    outcome,
    objections: uniq,
    competitors: [],
    whatWorked: hasClose ? 'Pushed toward meeting/next step' : 'Conversation captured',
    whatFailed: uniq.length ? `Objections: ${uniq.join(', ')}` : undefined,
    nextStep: hasClose ? 'Confirm meeting / follow up' : 'Qualify or park',
    upsellPotential: /complete|atmosphere|judie|pro/.test(lower) ? 'medium' : 'low',
    crossSellPotential: /atmosphere/.test(lower) && /judie|phone|missed/.test(lower) ? 'high' : 'medium',
    createdAt: new Date().toISOString(),
  };
}

/** Score a call. Uses heuristic first (always fast); optionally enrich via LLM later. */
export async function scoreSalesCall(opts: {
  callId: string;
  orgId?: string;
  agentPersona?: string;
  aim?: string | null;
}): Promise<SalesCallInsight> {
  const orgId = opts.orgId || getHomeOrgId();
  const base = heuristicScore(opts.callId, orgId, opts.agentPersona, opts.aim);

  try {
    const { createLLMClientForOrg, defaultChatModelForProvider } = await import('../llm-connection');
    const { client, provider } = await createLLMClientForOrg(orgId, 'sales_brain_score');
    const model = defaultChatModelForProvider(provider);
    const { text } = turnsText(opts.callId);
    if (text.length < 40) return base;

    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content:
            'Score a restaurant SaaS sales phone call. Reply JSON only with keys: reachedDm, rapportScore, discoveryScore, valueScore, closeScore (0-5), outcome, objections (array of short codes), whatWorked, whatFailed, nextStep, upsellPotential, crossSellPotential. Never invent prices. Objections codes: too_expensive,think_about_it,send_info,has_supplier,no_budget,call_later,not_interested,busy,need_approval,want_demo,other.',
        },
        { role: 'user', content: text.slice(0, 8000) },
      ],
    });
    const raw = String(completion.choices[0]?.message?.content || '').trim();
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd <= jsonStart) return base;
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
    const objs = Array.isArray(parsed.objections)
      ? parsed.objections.map((o) => normalizeObjection(String(o)))
      : base.objections;
    return {
      ...base,
      reachedDm: parsed.reachedDm != null ? String(parsed.reachedDm) : base.reachedDm,
      rapportScore: Number(parsed.rapportScore) || base.rapportScore,
      discoveryScore: Number(parsed.discoveryScore) || base.discoveryScore,
      valueScore: Number(parsed.valueScore) || base.valueScore,
      closeScore: Number(parsed.closeScore) || base.closeScore,
      outcome: parsed.outcome != null ? String(parsed.outcome) : base.outcome,
      objections: [...new Set(objs)].slice(0, 8),
      whatWorked: parsed.whatWorked != null ? String(parsed.whatWorked).slice(0, 240) : base.whatWorked,
      whatFailed: parsed.whatFailed != null ? String(parsed.whatFailed).slice(0, 240) : base.whatFailed,
      nextStep: parsed.nextStep != null ? String(parsed.nextStep).slice(0, 240) : base.nextStep,
      upsellPotential: parsed.upsellPotential != null ? String(parsed.upsellPotential) : base.upsellPotential,
      crossSellPotential: parsed.crossSellPotential != null ? String(parsed.crossSellPotential) : base.crossSellPotential,
    };
  } catch {
    return base;
  }
}
