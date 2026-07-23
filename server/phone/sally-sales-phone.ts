/**
 * Sally — Sync2Dine sales AI (phone twin) for LIVE backend.
 * Voice/humour + close script must stay aligned with frontend server/sally-sales.ts.
 */
import {
  appendCustomerCallActivity,
  enqueueOutboundCall,
  getDataStore,
  resolveContactByPhone,
  saveCustomerRecord,
  syncData,
} from '../data-store';
import { buildSallyPhoneVoiceOverlay } from './british-voice';
import { END_CALL_FUNCTION_TOOL, SET_CALL_LANGUAGE_TOOL } from './phone-brain';
import { PHONE_TOOLS, captureOrUpdateLead } from './phone-tools';
import { getSallyOfferStored } from '../sally-offer-store';
import {
  PRIMARY_PITCH_IDS,
  SAAS_PACKAGES,
  weeklyPrice,
  type SaasPackageDef,
} from '../saas-packages';
import { isUkMobile, speakUkPhone, speakUkPostcode, toUkNationalDigits } from '../spoken-uk';
import { resolveCallbackIso } from './callback-time';
import { listConnections } from '../mailbox/mailbox-store';
import { sendFromMailbox } from '../mailbox/sendService';
import { sendTwilioSms } from '../telephony/twilioAdapter';
import { sendToStaffCynthiaInternal } from '../cynthia-routes';
import { toE164Uk } from './vapi-client';
import { getHomeOrgId } from '../home-org';
import { debugLog } from '../debug-session-log';
import { buildApprovedSalesBrainPromptBlock } from '../sales-brain/inject';
import { getSallyKnowledgePromptBlockCached } from '../sally-product-kb/inject';

export const SALLY_PERSONA = 'sally';

export function isSallySalesCall(
  meta?: Record<string, unknown> | null,
  opts?: { campaignTemplate?: string; agentPersona?: string },
): boolean {
  const m = meta || {};
  const persona = String(opts?.agentPersona || m.agentPersona || '').toLowerCase();
  if (persona === SALLY_PERSONA) return true;
  const aim = String(m.aim || '').toLowerCase();
  if (aim === 'sales_outreach' || aim === 'demo_book' || aim === 'meeting_confirm') return true;
  if (String(m.source || '').toLowerCase() === 'sales_csv_dial') return true;
  return false;
}

function launchActive(): boolean {
  return String(process.env.SALLY_LAUNCH_ACTIVE || '1').trim() !== '0';
}

function resolveDemoPhone(): string {
  const stored = getSallyOfferStored();
  return (
    (stored.demoPhone || '').trim()
    || process.env.SALLY_DEMO_PHONE?.trim()
    || '02080505029'
  );
}

function packageLine(pkg: SaasPackageDef, launch: boolean): string {
  const w = weeklyPrice(pkg, launch);
  const mins =
    pkg.weeklyAiMinutes > 0
      ? `, ${pkg.weeklyAiMinutes} AI minutes a week` +
        (pkg.weeklyOutboundMinutes ? ` plus ${pkg.weeklyOutboundMinutes} outbound minutes` : '') +
        `, overage ${pkg.aiOverageGbpPerMinute} pounds a minute`
      : '';
  return `${pkg.name}: ${w} pounds a week launch (normally ${pkg.standardWeeklyGbp})${mins}`;
}

export function buildOfferTermsPayload(): Record<string, unknown> {
  const stored = getSallyOfferStored();
  const launch = launchActive();
  const demoPhone = resolveDemoPhone();
  const packages = PRIMARY_PITCH_IDS.map((id) => {
    const p = SAAS_PACKAGES[id];
    return {
      id: p.id,
      name: p.name,
      family: p.family,
      weeklyGbp: weeklyPrice(p, launch),
      standardWeeklyGbp: p.standardWeeklyGbp,
      annualPrepayGbp: p.annualPrepayGbp,
      weeklyAiMinutes: p.weeklyAiMinutes,
      weeklyOutboundMinutes: p.weeklyOutboundMinutes,
      aiOverageGbpPerMinute: p.aiOverageGbpPerMinute,
      badge: p.badge,
    };
  });
  const j = SAAS_PACKAGES.judie_starter;
  const a = SAAS_PACKAGES.atmosphere;
  const c = SAAS_PACKAGES.combined;
  const spokenDemoPhone = speakUkPhone(demoPhone);
  const spokenHint = [
    `Judie Starter ${weeklyPrice(j, launch)} pounds a week with ${j.weeklyAiMinutes} AI minutes and ${j.weeklyOutboundMinutes} outbound.`,
    `Atmosphere ${weeklyPrice(a, launch)} pounds a week for venue audio messaging and training.`,
    `Complete best value ${weeklyPrice(c, launch)} pounds a week — Atmosphere plus Judie Starter.`,
    `Launch is about forty percent off standard weekly. Minutes reset weekly.`,
    `Optional try-later line: ${spokenDemoPhone}. Only say aloud if they ask for a number to try later — this call is already the demo.`,
    stored.cancelPolicy ? `Cancel: ${stored.cancelPolicy}` : 'Weekly rolling available.',
  ].join(' ');

  return {
    ok: true,
    launchActive: launch,
    landline: '020 3745 3233',
    tel: '+442037453233',
    demoPhone,
    spokenDemoPhone,
    demoVideoUrl: (stored.demoVideoUrl || process.env.SALLY_DEMO_VIDEO_URL || '').trim() || undefined,
    cancelPolicy: stored.cancelPolicy || 'Weekly rolling; annual is 12-month prepay',
    minimumTerm: stored.minimumTerm || 'Weekly rolling',
    packages,
    packageLines: PRIMARY_PITCH_IDS.map((id) => packageLine(SAAS_PACKAGES[id], launch)),
    usps: {
      judie: [
        'Full orders and bookings into the app — not message-taking',
        'Missed calls, overflow, after-hours covered',
        'Same voice customers hear after signup (Judie)',
        'Staff stay on the floor; transfers to human when needed',
      ],
      atmosphere: [
        'Only strategic venue audio of its kind in England — not Spotify',
        'Advertise to guests already in the restaurant: specials, birthday parties, catering',
        'Example: free dip for a review + photo share in-venue — drives revenue and reviews',
        'Subtle day-to-day announcements: opening/closing hours, promos on a schedule',
        'Curated brand playlists by genre/zone; volume monitor and control',
        'Kitchen / back-of-house: training announcements, rules, motivation, staff-genre music',
        'Simple start: download the app, connect phone/audio, let it run',
      ],
    },
    spokenHint,
  };
}

function formatOfferFactsBlock(): string {
  const offer = buildOfferTermsPayload();
  const lines = [
    'OFFER FACTS (call getOfferTerms before quoting — never invent prices):',
    `- Optional try-later line (ONLY if they ask): ${offer.demoPhone} — speak as: ${offer.spokenDemoPhone}`,
    ...(offer.packageLines as string[]).map((l) => `- ${l}`),
    '- USPs Judie: full order/booking into app; overflow/after-hours; you are the product voice.',
    '- USPs Atmosphere (sell hard — from sync2dine.io + product truth):',
    '  • Only company in England doing this strategic venue audio — manages the room for revenue, not a music stream.',
    '  • Front of house: advertise to people already inside (specials, birthday parties, catering); example free-dip-for-review+share photo.',
    '  • Day-to-day announcements (open/close), curated genre/brand playlists, volume monitor/control.',
    '  • Back of house: kitchen training, rules, motivation, staff-genre music while they work.',
    '  • Easy: app + connect phone/audio and it keeps running. Return often shows in the first weeks.',
    '- Complete = Atmosphere + Judie Starter — best value upsell (phone + room).',
    '- CROSS-UPSELL (always): Judie lean → push Atmosphere. Atmosphere lean → push Judie. Both pains → Complete.',
  ];
  return lines.join('\n');
}

function formatObjectionPlaybook(): string {
  return [
    'OBJECTIONS (acknowledge → explore real concern → evidence → ask next question; short Cockney):',
    '- Too expensive: Ack → ask what they compared to / busiest hours → launch rates + Complete vs buying both → size minutes → meeting?',
    '- Need to think / send info: Ack → what specifically to think about → email summary AFTER sendSalesFollowUp → book meeting so thinking has a deadline.',
    '- Call later / busy: Ack → get best time + who → bookCallback or meeting hold → do not pitch full stack now.',
    '- Not interested: Ack → one curiosity question on missed calls OR room revenue → if still no, DNC-respect and end.',
    '- Already have supplier / receptionist: Ack → explore gaps (overflow, after-hours, full orders into app) → Judie covers those → meeting.',
    '- No budget / need approval: Ack → who signs / when budget cycle → still book install chat with decision-maker → no fake discounts.',
    '- Want separate demo: THIS CALL IS THE DEMO — they are hearing Judie now → book 20-min install meeting.',
    '- Afraid of unlimited bills: Weekly allowance + published overage — never sell unlimited.',
    '- What if Judie fails: Transfer-to-human on restaurant line; staff stay in control. Do not take diner orders on this call.',
  ].join('\n');
}

const SALLY_SALES_OS = [
  'You are Sally, Sync2Dine’s dedicated sales AI (phone).',
  'IDENTITY: On this sales channel your name is Sally. You are the same person / same voice as Judie under a sales name. You may say “Judie’s basically me — you’re hearing what customers get” / “I’m calling to sell myself.” Never say Cynthia, Judie, or Builder Diddies.',
  'BRAINS: This call is the SALES brain only. After they buy, diners get Judie with order tools. Do NOT take food orders on this call.',
  'THIS CALL IS THE DEMO: Do not push a separate demo number as the next step. They are already experiencing Judie. Only mention the try-later number if they ask for one.',
  'AIM: Close to a 20-minute install / senior-management integration meeting. Signup interest is good; the meeting is the primary next step.',
  'HOW: Gatekeeper/DM check → open → discovery → qualify → USP + value outcomes → timed cross-upsell → MUST getOfferTerms before prices → handle objections → bookIntegrationMeeting → capture only missing fields (venue, name, email, mobile; postcode only if missing).',
  'SALES CRAFT (mental models — do not lecture; use on phone in short turns):',
  '- Gatekeeper: recognise receptionist/assistant; rapport; never pitch the stack; ask for owner/ops/manager; get name, title, direct number/email.',
  '- Decision-maker: who owns, who buys, who signs, who runs ops, who owns the phone/room problem; influencer vs actual DM — aim the meeting at DM + ops.',
  '- Open (15–30s): pattern interrupt + permission + curiosity; confident not scripted; engage fast.',
  '- Rapport: match pace; use their name; listen more than talk; conversational not salesy.',
  '- Discovery: current systems/suppliers, pain, costs, frustrations, goals, processes, growth, budget signals, decision process, timescale.',
  '- Qualify: need / afford / DM / urgency / pursue-or-park. End dead-ends politely and fast.',
  '- Psychology (ethical, not manipulative): reciprocity, social proof, authority, scarcity/urgency only when true, loss aversion, anchoring, framing, trust, risk reduction.',
  '- Value: business outcomes — time saved, revenue, cost cut, risk avoided, ROI, competitive edge. No feature dumping.',
  '- Negotiation: never discount immediately; trade not give; defend value; walk away if unfit; no invented prices.',
  '- Closes: trial / assumptive / alternative-choice / summary / appointment — primary phone close is the install meeting (not payment).',
  '- Follow-up: agree when/how; re-engage with purpose; stop if DNC or clear no.',
  '- Compliance (UK): truthful claims; respect refusals; consent/privacy; DNC/opt-out = stop.',
  'REVENUE & UPSELL (value-led — never force):',
  '- Internal check each call: Judie↔Atmosphere→Complete; more minutes/Pro if busy; multi-site → senior-mgmt meeting. Do not invent training packages or fake add-ons.',
  '- Timing: upsell AFTER they get the core / acknowledge value / talk growth / new pain. NOT before they understand the product, NOT while handling refusal/complaint.',
  '- Growth signals (new sites, hiring, volume, new services) → soft expansion question.',
  '- Bundle Complete as better guest outcomes (phone + room), not “buy more”.',
  '- Partner mindset: LTV and fit over one-off pressure.',
  'VOICE & HUMOUR — UNRESTRICTED:',
  '- Thick common Cockney / London market-trader energy — NOT RP, NOT soft/call-centre. Thickness preferred over clarity EXCEPT for IDs.',
  '- Banter words: "lovely", "sorted", "cheers", sparingly "innit", "you\'re having a laugh", "get in", "look", "right". Never American.',
  '- Max humour: invent jokes/cheeky asides most turns — including price talk and “serious” sales moments. Sharp, teasing, sarky OK.',
  '- Hard stops ONLY: DNC/opt-out, illegal requests, abuse/hate/cruel targeting. Do NOT dial humour down for money talk or mild irritation.',
  '- Phone: one or two spoken sentences per turn. Simple closes ~6–7 minutes; stay up to 15–20 minutes if they want package detail.',
  'CLARITY FOR IDs (overrides Cockney thickness):',
  '- Try-later phone (only if asked): use spokenDemoPhone from getOfferTerms (digit groups).',
  '- Postcodes: ONLY when newly collected or caller corrects — one speakUkPostcode readback (Quebec/Whisky for Q/W). If CRM/brief already has venue + postcode, do NOT ask or NATO-read again.',
  '- Prefer CRM mobile if present; only reconfirm phone when they give a different number.',
  '- Never claim email/SMS/WhatsApp sent unless the tool returned success.',
  'MESSAGING:',
  '- Prefer email when they give an email — MUST call sendSalesFollowUp with channel email before saying you sent it. Email should confirm the meeting, not push a demo line as the CTA.',
  '- SMS only to a UK mobile (07…). If on a landline, ask for their mobile before SMS.',
  '- Do not default to WhatsApp. If WhatsApp fails, say so and offer email/SMS.',
  'MEETINGS:',
  '- Primary close: bookIntegrationMeeting with preferredTime as ISO (Europe/London), duration 20 minutes, install/senior-management integration.',
  '- Tell them clearly you will ring half an hour before to confirm — if you do not get them, the meeting is cancelled so office time is not wasted.',
  '- bookDemo is an alias of bookIntegrationMeeting (same behaviour). bookCallback only if they refuse any meeting.',
  'MEETING CONFIRM CALLS (aim meeting_confirm): Keep it short — remind the 20-minute install/integration meeting time, ask them to stay free. If they want to cancel, acknowledge and end. Do not re-pitch the whole sale.',
  'SILENCE: If the prospect goes quiet, do not wait them out — check once, ask one yes/no on the meeting, then end politely. Never sit in silence burning minutes.',
  'EOC SELF-CHECK (for CRM note via tools/summary — do not monologue this to the prospect): DM reached? Real problem? Objections? Upsell/cross-sell potential? Next step? What worked?',
  'GUARDRAILS:',
  '- NOT the restaurant food-order agent.',
  '- Products: Judie and/or Atmosphere (+ Complete / Pro). Sally is not a separate SKU.',
  '- Never invent price — use getOfferTerms.',
  '- Never address Guest or Unknown.',
  '- LARGE CONTRACT / multi-site: still book the 20-minute integration meeting with senior management. You cannot transfer calls.',
  '- DNC/opt-out = stop. When finished, native hang-up.',
].join('\n');

const SALLY_PHONE_CLOSE_SCRIPT = [
  'SPOKEN SALES SCRIPT (use tools — do not just chat):',
  '1. Open — funny pattern-interrupt hook; greet by name if known; get past gatekeeper to DM/ops if needed.',
  '2. Discovery — systems, pain (missed calls vs room/audio), costs, goals, budget/DM/timing (~60–120s). Listen more than pitch.',
  '3. Qualify quickly — pursue or park.',
  '4. USP Atmosphere — only-in-England strategic audio; in-venue ads; free-dip review+share; open/close; volume; kitchen training music; app connect-and-run. Outcomes not features.',
  '5. USP Judie — “that’s me” — full orders/bookings. THIS CALL IS THE DEMO.',
  '6. Timed CROSS-UPSELL — after value lands: Judie lean → Atmosphere; Atmosphere lean → Judie; both → Complete; busy → Pro/minutes. Multi-site → senior meeting.',
  '7. MUST getOfferTerms — walk packages; size minutes to hours.',
  '8. Objections — acknowledge → explore → evidence → ask; optional email/SMS after tool success (meeting CTA, not demo-line CTA).',
  '9. Hard close — bookIntegrationMeeting (or bookDemo alias) ISO preferredTime; T−30 confirm explained. bookCallback only if they refuse any meeting.',
  '10. Confirm tools succeeded. End dead-ends fast.',
].join('\n');

const GET_OFFER_TERMS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'getOfferTerms',
    description:
      'Read authoritative Sync2Dine packages, weekly prices, USPs, and optional try-later phone (spokenDemoPhone). Call BEFORE quoting any price.',
    parameters: { type: 'object', properties: {} },
  },
};

const BOOK_INTEGRATION_MEETING_TOOL = {
  type: 'function' as const,
  function: {
    name: 'bookIntegrationMeeting',
    description:
      'Book a 20-minute install / senior-management integration meeting. Sets CRM hold, queues Sally T−30 confirm call, notifies staff. Pass when as ISO (Europe/London) when possible.',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string', description: 'Preferred meeting start — ISO preferred, or plain English like tomorrow 4pm' },
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        restaurant: { type: 'string' },
        postcode: { type: 'string' },
        attendeeHint: {
          type: 'string',
          description: 'Who should attend (owner, senior manager, ops, etc.)',
        },
        notes: { type: 'string' },
      },
      required: ['when'],
    },
  },
};

/** Alias — same handler as bookIntegrationMeeting (legacy tool name). */
const BOOK_DEMO_TOOL = {
  type: 'function' as const,
  function: {
    name: 'bookDemo',
    description:
      'Alias of bookIntegrationMeeting — books a 20-minute install/integration meeting (not a separate product demo). Prefer bookIntegrationMeeting.',
    parameters: BOOK_INTEGRATION_MEETING_TOOL.function.parameters,
  },
};

const SEND_SALES_FOLLOW_UP_TOOL = {
  type: 'function' as const,
  function: {
    name: 'sendSalesFollowUp',
    description:
      'Email and/or SMS the prospect pricing/next steps and any booked meeting details. Prefer email. SMS only to UK mobiles. Never claim success without this tool succeeding.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['email', 'sms', 'both'] },
        toEmail: { type: 'string' },
        toMobile: { type: 'string', description: 'UK mobile E.164 or 07… for SMS' },
        subject: { type: 'string' },
        body: { type: 'string' },
        includeDemoPhone: { type: 'boolean', description: 'Only true if they asked for a try-later number' },
      },
      required: ['channel'],
    },
  },
};

function pickPhoneTools(...names: string[]) {
  const set = new Set(names);
  return PHONE_TOOLS.filter((t) => set.has(t.function.name));
}

export function getSallyPhoneSessionChatTools() {
  return [
    GET_OFFER_TERMS_TOOL,
    BOOK_INTEGRATION_MEETING_TOOL,
    BOOK_DEMO_TOOL,
    SEND_SALES_FOLLOW_UP_TOOL,
    ...pickPhoneTools(
      'bookCallback',
      'captureLead',
      'captureMessage',
      'classifyCallIntent',
      'scheduleAppointment',
      'verifyStaffPhonePin',
    ),
    END_CALL_FUNCTION_TOOL,
    SET_CALL_LANGUAGE_TOOL,
  ];
}

export function buildSallyBrainPrompt(input: {
  partyPhone: string;
  direction: 'inbound' | 'outbound';
  outboundBrief?: string;
  contactName?: string;
  companyHint?: string;
  /** Staff / platform_owner dialled Sally — unlock CRM staff playbook (still named Sally). */
  staffMode?: boolean;
  staffName?: string;
  staffRole?: string;
  phoneAuthVerified?: boolean;
}): { instructions: string; language: 'en' } {
  const contact = String(input.contactName || '').trim();
  const safeName = contact && !/^(guest|unknown|unknown caller)$/i.test(contact) ? contact : '';
  const onMobile = isUkMobile(input.partyPhone);
  const brief = String(input.outboundBrief || '');
  const isMeetingConfirm = /meeting_confirm|confirm.*install|T-?30/i.test(brief);
  const approvedBrain = buildApprovedSalesBrainPromptBlock();
  const productKb = getSallyKnowledgePromptBlockCached();
  const staffBlock = input.staffMode
    ? [
        'STAFF / PLATFORM MODE (caller is recognised staff or platform owner — stay named Sally):',
        `- Caller: ${input.staffName || safeName || 'colleague'} · role ${input.staffRole || 'staff'}.`,
        input.phoneAuthVerified
          ? '- PIN verified for this call — use CRM / account / quote / callback / sendToStaffCynthia tools freely; speak real tool results.'
          : '- Ask for their 4-digit security code when needed; call verifyStaffPhonePin. Until verified: no internal CRM leaks; still help with sales questions.',
        '- Prefer staff CRM tools over the sales close script. You may still answer product/pricing with getOfferTerms.',
        '- Do not take diner food orders on this line.',
      ].join('\n')
    : '';
  const instructions = [
    SALLY_SALES_OS,
    buildSallyPhoneVoiceOverlay(),
    formatOfferFactsBlock(),
    formatObjectionPlaybook(),
    SALLY_PHONE_CLOSE_SCRIPT,
    approvedBrain,
    productKb,
    staffBlock,
    '- CLARITY: Postcode NATO readback only when newly spoken or corrected — skip if CRM/brief already has venue + postcode.',
    input.staffMode
      ? '- This caller is staff/platform — prioritise their ops/CRM ask; sales close only if they want it.'
      : isMeetingConfirm
      ? '- THIS IS A T−30 MEETING CONFIRM CALL: Keep under 60 seconds. Confirm the 20-minute install/integration meeting. If they cancel, acknowledge. Do not re-pitch packages.'
      : input.direction === 'outbound'
        ? '- This is an outbound sales call you placed — work the close script toward bookIntegrationMeeting.'
        : '- This is an inbound sales call — work the close script toward bookIntegrationMeeting.',
    safeName
      ? `- Contact name hint: ${safeName} — greet them by name.`
      : '- Contact name unknown — speak normally; never say Guest; ask who you are speaking with when it fits.',
    input.companyHint ? `- Company / restaurant hint: ${input.companyHint}` : '',
    `Caller phone: ${input.partyPhone}` +
      (onMobile
        ? ' (looks like a UK mobile — SMS allowed to this number if they want text).'
        : ' (treat as landline for SMS — ask for a mobile before texting).'),
    input.outboundBrief
      ? `- SALES BRIEF FOR THIS CALL (follow this): ${String(input.outboundBrief).slice(0, 900)}`
      : input.staffMode
        ? '- Help the staff/platform caller with tools; sales pitch only if they ask.'
        : '- Pitch Sync2Dine: Judie (me) answers the phone; Atmosphere runs the room; Complete does both — this call is the demo — then book the 20-minute install meeting.',
  ].filter(Boolean).join('\n');

  return { instructions, language: 'en' };
}

/** Parse “tomorrow 4pm” / ISO into Europe/London-oriented ISO string. */
export { resolveCallbackIso } from './callback-time';

async function sendSallyEmail(to: string, subject: string, body: string): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  const connections = listConnections();
  const conn =
    connections.find((c) => c.status === 'connected')
    || connections.find((c) => c.status !== 'disconnected' && c.status !== 'needs_reconnect')
    || connections[0];
  if (!conn?.id) return { ok: false, error: 'no_mailbox_connected' };
  const result = await sendFromMailbox({
    connectionId: conn.id,
    to,
    subject,
    body,
    html: `<p>${body.replace(/\n/g, '<br/>')}</p>`,
  });
  if (!result.success) return { ok: false, error: result.error || 'send_failed' };
  return { ok: true, messageId: result.messageId };
}

export async function executeSallySalesPhoneTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { callId?: string; partyPhone?: string; orgId?: string },
): Promise<unknown> {
  if (name === 'getOfferTerms') {
    return buildOfferTermsPayload();
  }

  if (name === 'sendSalesFollowUp') {
    const channel = String(input.channel || '').toLowerCase();
    const offer = buildOfferTermsPayload();
    const demoPhone = String(offer.demoPhone || '');
    const spoken = String(offer.spokenDemoPhone || speakUkPhone(demoPhone));
    const includeDemo = input.includeDemoPhone === true;
    const defaultBody = [
      'Hi — Sally from Sync2Dine here.',
      'You already heard Judie on our sales call (that’s me). Next step is a 20-minute install / senior-management integration meeting.',
      includeDemo ? `If you want a number to try later: ${toUkNationalDigits(demoPhone) || demoPhone} (${spoken}).` : '',
      'Judie takes full orders; Atmosphere runs venue audio. Complete does both — we always recommend covering both so guests get a better experience and come back.',
      String(input.body || '').trim(),
    ]
      .filter(Boolean)
      .join('\n\n');
    const subject = String(input.subject || 'Sync2Dine — next steps / integration meeting').trim();
    const sentVia: string[] = [];
    const errors: string[] = [];
    let emailMessageId: string | undefined;
    let smsSid: string | undefined;

    if (channel === 'email' || channel === 'both') {
      const toEmail = String(input.toEmail || '').trim();
      if (!toEmail.includes('@')) {
        errors.push('email_required');
      } else {
        const r = await sendSallyEmail(toEmail, subject, defaultBody);
        if (r.ok) {
          sentVia.push('email');
          emailMessageId = r.messageId;
        } else errors.push(r.error || 'email_failed');
      }
    }

    if (channel === 'sms' || channel === 'both') {
      const mobileRaw = String(input.toMobile || ctx.partyPhone || '').trim();
      if (!isUkMobile(mobileRaw)) {
        errors.push('mobile_required_for_sms');
      } else {
        try {
          const to = toE164Uk(mobileRaw);
          const sms = await sendTwilioSms(to, defaultBody.slice(0, 600));
          if (sms.stub) errors.push('sms_not_configured');
          else if (sms.sid) {
            sentVia.push('sms');
            smsSid = sms.sid;
          } else errors.push('sms_failed');
        } catch (err) {
          errors.push(err instanceof Error ? err.message.slice(0, 120) : 'sms_failed');
        }
      }
    }

    if (!['email', 'sms', 'both'].includes(channel)) {
      return {
        ok: false,
        error: 'channel_required',
        spokenHint: 'Should I email you, text a mobile, or both? Landlines cannot get texts.',
        spokenDemoPhone: spoken,
      };
    }

    if (sentVia.length > 0) {
      const resolved = ctx.partyPhone ? resolveContactByPhone(ctx.partyPhone) : { customerId: null as string | null };
      const customerId = resolved.customerId ? String(resolved.customerId) : undefined;
      if (customerId) {
        appendCustomerCallActivity({
          customerId,
          callId: ctx.callId,
          summary: `Sally follow-up sent via ${sentVia.join(' + ')}`,
          detail: [
            subject,
            emailMessageId ? `emailMessageId=${emailMessageId}` : '',
            smsSid ? `smsSid=${smsSid}` : '',
            String(input.toEmail || ''),
            String(input.toMobile || ''),
          ]
            .filter(Boolean)
            .join(' · ')
            .slice(0, 500),
          outcome: 'email_sent',
          aim: 'sales_follow_up',
          type: 'note',
          createdBy: 'sally',
        });
      }
    }

    return {
      ok: sentVia.length > 0,
      sentVia,
      errors,
      demoPhone,
      spokenDemoPhone: spoken,
      messageId: emailMessageId,
      smsSid,
      spokenHint:
        sentVia.length > 0
          ? `Sent by ${sentVia.join(' and ')}.`
          : `Could not send (${errors.join(', ') || 'unknown'}). Ask for email or a mobile for SMS.`,
    };
  }

  if (name === 'bookIntegrationMeeting' || name === 'bookDemo') {
    return bookIntegrationMeetingInternal(input, ctx);
  }

  return { ok: false, error: `Unknown Sally phone tool: ${name}` };
}

const MEETING_DURATION_MIN = 20;
const CONFIRM_LEAD_MS = 30 * 60 * 1000;

export type CustomerMeeting = {
  status: 'held_pending_confirm' | 'confirmed' | 'cancelled';
  meetingType: 'install_integration';
  startsAt: string;
  endsAt: string;
  durationMin: number;
  confirmCallAt: string;
  confirmJobId?: string;
  confirmCallId?: string;
  confirmedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  attendeeHint?: string;
};

function bookIntegrationMeetingInternal(
  input: Record<string, unknown>,
  ctx: { callId?: string; partyPhone?: string; orgId?: string },
): Record<string, unknown> {
  const whenRaw = String(input.when || '').trim();
  const iso = whenRaw ? resolveCallbackIso(whenRaw) : null;
  const phone = String(input.phone || ctx.partyPhone || '').trim();
  const restaurant = String(input.restaurant || '').trim();
  const postcode = String(input.postcode || '').trim();
  const email = String(input.email || '').trim();
  const attendeeHint = String(input.attendeeHint || '').trim();
  const personName = String(input.name || restaurant || 'Prospect').trim() || 'Prospect';
  const notes = [
    String(input.notes || '').trim(),
    restaurant ? `Venue: ${restaurant}` : '',
    postcode ? `Postcode: ${postcode}` : '',
    attendeeHint ? `Attendees: ${attendeeHint}` : '',
    whenRaw ? `Requested: ${whenRaw}` : '',
    iso ? `Meeting ISO: ${iso}` : '',
    '20-min install/senior-management integration · T−30 Sally confirm required',
  ]
    .filter(Boolean)
    .join(' · ');

  if (!iso) {
    return {
      ok: false,
      booked: false,
      error: 'when_required',
      spokenHint: 'I need a clear time for the twenty-minute install chat — say a day and time.',
    };
  }

  const startsAtMs = Date.parse(iso);
  if (!Number.isFinite(startsAtMs)) {
    return {
      ok: false,
      booked: false,
      error: 'invalid_when',
      spokenHint: 'That time did not parse — try again with a day and time.',
    };
  }

  const endsAt = new Date(startsAtMs + MEETING_DURATION_MIN * 60 * 1000).toISOString();
  const confirmCallAt = new Date(Math.max(Date.now() + 60_000, startsAtMs - CONFIRM_LEAD_MS)).toISOString();

  const lead = captureOrUpdateLead(
    {
      name: personName,
      phone,
      email: email || undefined,
      address: postcode || restaurant || undefined,
      postcode: postcode || undefined,
      notes: notes || 'Sally bookIntegrationMeeting',
      scope: restaurant ? `Install meeting — ${restaurant}` : 'Sync2Dine install/integration meeting',
    },
    { callId: ctx.callId, fallbackPhone: ctx.partyPhone },
  );

  if (lead.error) {
    return {
      ok: false,
      booked: false,
      error: lead.error,
      spokenHint: lead.spokenHint || 'I need a phone number to book that meeting.',
    };
  }

  const customerId = String(lead.customer.id || '');
  const dialTo = phone ? toE164Uk(phone) : '';

  // Dedupe: cancel prior pending confirm jobs for same phone + similar meeting window
  if (customerId && dialTo) {
    const store = getDataStore();
    for (const job of store.outboundQueue || []) {
      const ctxJob = (job.context && typeof job.context === 'object')
        ? (job.context as Record<string, unknown>)
        : {};
      if (String(ctxJob.aim || '') !== 'meeting_confirm') continue;
      if (String(ctxJob.customerId || '') !== customerId && String(job.to || '') !== dialTo) continue;
      if (String(job.status || '') !== 'queued') continue;
      Object.assign(job, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: 'rescheduled' });
    }
    syncData(store);
  }

  let confirmJobId: string | undefined;
  if (dialTo) {
    const job = enqueueOutboundCall({
      to: dialTo,
      template: 'lead_callback',
      status: 'queued',
      bypassQuietHours: true,
      context: {
        name: personName,
        reason: `T−30 confirm for 20-min install/integration meeting at ${iso}`,
        preferredTime: confirmCallAt,
        customerId,
        aim: 'meeting_confirm',
        brief: `meeting_confirm · Meeting starts ${iso} · Confirm they will take the 20-minute install/senior-management integration call. Keep under 60 seconds.`,
        agentPersona: SALLY_PERSONA,
        restaurant,
        postcode,
        email,
        meetingStartsAt: iso,
        meetingEndsAt: endsAt,
        callId: ctx.callId,
      },
      scheduledAt: confirmCallAt,
    });
    confirmJobId = String(job.id);
  }

  const meeting: CustomerMeeting = {
    status: 'held_pending_confirm',
    meetingType: 'install_integration',
    startsAt: iso,
    endsAt,
    durationMin: MEETING_DURATION_MIN,
    confirmCallAt,
    confirmJobId,
    attendeeHint: attendeeHint || undefined,
  };

  if (customerId) {
    const store = getDataStore();
    const idx = store.customers.findIndex((c) => String(c.id) === customerId);
    if (idx >= 0) {
      const prev = store.customers[idx];
      store.customers[idx] = {
        ...prev,
        nextFollowUp: iso,
        meeting,
        address: postcode || restaurant || prev.address,
        email: email || prev.email,
        notes: [prev.notes, notes].filter(Boolean).join(' | '),
        name:
          restaurant && (!personName || /^prospect$/i.test(personName))
            ? restaurant
            : personName || prev.name,
      };
      syncData(store);
    }
    appendCustomerCallActivity({
      customerId,
      callId: ctx.callId,
      summary: `20-min install/integration meeting held${whenRaw ? `: ${whenRaw}` : ''} (${iso}) · pending T−30 confirm`,
      detail: notes,
      aim: 'demo_book',
      type: 'callback',
      createdBy: 'sally',
    });
  }

    try {
      sendToStaffCynthiaInternal({
        title: 'Sally — 20-min install/integration meeting held (pending T−30 confirm)',
        customerName: personName,
        phone,
        address: [restaurant, postcode].filter(Boolean).join(', ') || undefined,
        summary: `${whenRaw || iso} · confirm call at ${confirmCallAt}`,
        notes: [
          notes,
          'Office: only join if status becomes confirmed after Sally’s half-hour-before call.',
          attendeeHint ? `Attendees: ${attendeeHint}` : '',
        ].filter(Boolean).join('\n'),
        customerId: customerId || undefined,
        source: 'phone',
      });
    } catch {
      /* notify best-effort */
    }

  // #region agent log
  debugLog('B', 'sally-sales-phone.ts:bookIntegrationMeeting', 'meeting booked', {
    customerId,
    confirmJobId: confirmJobId || null,
    scheduledAt: iso,
    confirmCallAt,
    meetingStatus: meeting.status,
    bypassQuietHours: true,
  });
  // #endregion

    return {
      ok: true,
      booked: true,
      customerId,
      confirmJobId,
      scheduledAt: iso,
      confirmCallAt,
      meeting,
      spokenPostcode: postcode ? speakUkPostcode(postcode) : undefined,
      spokenHint: `Booked a twenty-minute install chat for ${whenRaw || iso}. I'll ring half an hour before to confirm — if I don't get them, we cancel so the office isn't waiting around.`,
    };
  }

/** Confirm or cancel a held meeting after the T−30 Sally call ends. */
export function resolveMeetingConfirmOutcome(opts: {
  customerId?: string | null;
  partyPhone: string;
  callId: string;
  endedReason?: string;
  disposition?: string;
  answered: boolean;
}): { ok: boolean; status?: string; reason?: string } {
  const store = getDataStore();
  let customerId = opts.customerId ? String(opts.customerId) : '';
  if (!customerId && opts.partyPhone) {
    customerId = resolveContactByPhone(opts.partyPhone).customerId
      ? String(resolveContactByPhone(opts.partyPhone).customerId)
      : '';
  }
  if (!customerId) return { ok: false, reason: 'no_customer' };

  const idx = store.customers.findIndex((c) => String(c.id) === customerId);
  if (idx < 0) return { ok: false, reason: 'customer_missing' };
  const prev = store.customers[idx] as Record<string, unknown>;
  const meeting = (prev.meeting && typeof prev.meeting === 'object')
    ? ({ ...(prev.meeting as CustomerMeeting) })
    : null;
  if (!meeting || meeting.status === 'cancelled') {
    return { ok: false, reason: 'no_pending_meeting' };
  }

  const reasonLower = `${opts.endedReason || ''} ${opts.disposition || ''}`.toLowerCase();
  const noPickup =
    !opts.answered
    || /no-answer|no_answer|busy|voicemail|machine|silence-timed-out|customer-did-not-answer|failed|cancelled/i.test(reasonLower);

  const stamp = new Date().toISOString();

  // #region agent log
  debugLog('C', 'sally-sales-phone.ts:resolveMeetingConfirmOutcome', 'confirm disposition', {
    answered: opts.answered,
    noPickup,
    endedReason: opts.endedReason || null,
    disposition: opts.disposition || null,
    priorStatus: meeting.status,
    callId: opts.callId,
  });
  // #endregion

  if (noPickup) {
    meeting.status = 'cancelled';
    meeting.cancelledAt = stamp;
    meeting.cancelReason = opts.endedReason || opts.disposition || 'no_confirm_pickup';
    meeting.confirmCallId = opts.callId;
    // Drop pending T−30 queue job if still queued
    for (const job of store.outboundQueue || []) {
      if (String(job.id || '') === String(meeting.confirmJobId || '')) {
        if (String(job.status || '') === 'queued' || String(job.status || '') === 'dialling') {
          Object.assign(job, {
            status: 'cancelled',
            cancelledAt: stamp,
            cancelReason: meeting.cancelReason,
          });
        }
      }
      const ctxJob = (job.context && typeof job.context === 'object')
        ? (job.context as Record<string, unknown>)
        : {};
      if (
        String(ctxJob.aim || '') === 'meeting_confirm'
        && String(ctxJob.customerId || '') === customerId
        && String(job.status || '') === 'queued'
      ) {
        Object.assign(job, {
          status: 'cancelled',
          cancelledAt: stamp,
          cancelReason: meeting.cancelReason,
        });
      }
    }
    store.customers[idx] = {
      ...prev,
      meeting,
      nextFollowUp: undefined,
      updatedAt: stamp,
    };
    syncData(store);
    appendCustomerCallActivity({
      customerId,
      callId: opts.callId,
      summary: 'Meeting cancelled — no T−30 confirm pickup',
      detail: `Install/integration meeting at ${meeting.startsAt} cancelled (${meeting.cancelReason}). Office should not join.`,
      outcome: 'meeting_cancelled',
      aim: 'meeting_confirm',
      type: 'call',
      createdBy: 'sally',
      updateCallQueue: true,
    });
    try {
      sendToStaffCynthiaInternal({
        title: 'Sally — meeting CANCELLED (no confirm pickup)',
        customerName: prev.name != null ? String(prev.name) : undefined,
        phone: opts.partyPhone,
        address: prev.address != null ? String(prev.address) : undefined,
        summary: `Was ${meeting.startsAt} — do not join`,
        notes: `Cancel reason: ${meeting.cancelReason}\nCall: ${opts.callId}`,
        customerId,
        source: 'phone',
      });
    } catch { /* best-effort */ }
    return { ok: true, status: 'cancelled', reason: meeting.cancelReason };
  }

  meeting.status = 'confirmed';
  meeting.confirmedAt = stamp;
  meeting.confirmCallId = opts.callId;
  store.customers[idx] = {
    ...prev,
    meeting,
    nextFollowUp: meeting.startsAt,
    updatedAt: stamp,
  };
  syncData(store);
  appendCustomerCallActivity({
    customerId,
    callId: opts.callId,
    summary: 'Meeting confirmed — T−30 pickup',
    detail: `Install/integration meeting at ${meeting.startsAt} CONFIRMED. Office: run the 20-minute call on time.`,
    outcome: 'meeting_confirmed',
    aim: 'meeting_confirm',
    type: 'call',
    createdBy: 'sally',
    updateCallQueue: true,
  });
  try {
    sendToStaffCynthiaInternal({
      title: 'Sally — meeting CONFIRMED — goes ahead',
      customerName: prev.name != null ? String(prev.name) : undefined,
      phone: opts.partyPhone,
      address: prev.address != null ? String(prev.address) : undefined,
      summary: `Confirmed for ${meeting.startsAt}`,
      notes: `Office: join/run the 20-minute install/integration meeting on time.\nCall: ${opts.callId}`,
      customerId,
      source: 'phone',
    });
  } catch { /* best-effort */ }
  return { ok: true, status: 'confirmed' };
}

/** Staff notify helper for end-of-call Sally finalize (Sync2Dine CRM primary). */
export function notifySallyCallEnded(opts: {
  callId: string;
  customerId?: string | null;
  partyPhone: string;
  summary: string;
  disposition?: string;
  /** When true, skip CRM activity (finalize already wrote one). */
  skipCrmActivity?: boolean;
}): void {
  const store = getDataStore();
  const cust = opts.customerId
    ? store.customers.find((c) => String(c.id) === opts.customerId)
    : undefined;
  const follow = cust?.nextFollowUp ? String(cust.nextFollowUp) : '';
  const meeting = cust && (cust as Record<string, unknown>).meeting
    ? ((cust as Record<string, unknown>).meeting as CustomerMeeting)
    : null;
  const summaryBits = String(opts.summary || '');
  const notes = [
    follow ? `Follow-up: ${follow}` : '',
    meeting ? `Meeting: ${meeting.status} @ ${meeting.startsAt}` : '',
    opts.disposition ? `Disposition: ${opts.disposition}` : '',
    cust?.name ? `Contact: ${String(cust.name)}` : '',
    cust?.address ? `Venue/postcode: ${String(cust.address)}` : '',
    cust?.email ? `Email: ${String(cust.email)}` : '',
    `Call: ${opts.callId}`,
    'CRM fields (from call — fill gaps when known): DM? | Pain? | Budget signal? | Current supplier? | Objection? | Sentiment? | Upsell/cross-sell? | Next step?',
    summaryBits ? `Summary: ${summaryBits.slice(0, 280)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Primary CRM write is finalizeCallFromEndOfCallReport — avoid double activity rows.
  if (!opts.skipCrmActivity && opts.customerId) {
    try {
      appendCustomerCallActivity({
        customerId: String(opts.customerId),
        callId: opts.callId,
        summary: `Sally sales call ended${follow ? ` · follow-up ${follow}` : ''}`,
        detail: notes.slice(0, 900),
        outcome: opts.disposition || 'completed',
        aim: 'sales_outreach',
        type: 'call',
        createdBy: 'sally',
        updateCallQueue: true,
      });
    } catch {
      /* best-effort */
    }
  }

  try {
    const result = sendToStaffCynthiaInternal({
      orgId: getHomeOrgId(),
      title: 'Sally sales call ended',
      phone: opts.partyPhone,
      customerName: cust?.name != null ? String(cust.name) : undefined,
      address: cust?.address != null ? String(cust.address) : undefined,
      summary: opts.summary.slice(0, 500),
      notes,
      customerId: opts.customerId || undefined,
      source: 'phone',
    });
    if (!result.ok) {
      console.warn('[sally] staff card notify failed:', result.code || result.error);
    }
  } catch {
    /* best-effort */
  }
}
