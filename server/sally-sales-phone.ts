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
} from './data-store';
import { buildSallyPhoneVoiceOverlay } from './british-voice';
import { END_CALL_FUNCTION_TOOL, SET_CALL_LANGUAGE_TOOL } from './phone-brain';
import { PHONE_TOOLS, captureOrUpdateLead } from './phone-tools';
import { getSallyOfferStored } from './sally-offer-store';
import {
  PRIMARY_PITCH_IDS,
  SAAS_PACKAGES,
  weeklyPrice,
  type SaasPackageDef,
} from './saas-packages';
import { isUkMobile, speakUkPhone, speakUkPostcode, toUkNationalDigits } from './spoken-uk';
import { resolveCallbackIso } from './callback-time';
import { listConnections } from './mailbox/mailbox-store';
import { sendFromMailbox } from './mailbox/sendService';
import { sendTwilioSms } from './telephony/twilioAdapter';
import { sendToStaffCynthiaInternal } from './cynthia-routes';
import { toE164Uk } from './vapi-client';
import { getHomeOrgId } from './home-org';

export const SALLY_PERSONA = 'sally';

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

/** Strip to comparable UK national digits (no leading 44/0). */
export function phoneDigitsForMatch(input: string): string {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('44') && digits.length >= 11) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

/** Numbers whose inbound voice should always use Sally sales (demo / Twilio / allowlist). */
export function listSallyInboundNumbers(): string[] {
  const fromAllowlist = String(process.env.SALLY_INBOUND_NUMBERS || '')
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    resolveDemoPhone(),
    process.env.TWILIO_FROM_NUMBER,
    process.env.TWILIO_PHONE_NUMBER,
    ...fromAllowlist,
  ]
    .map((n) => String(n || '').trim())
    .filter(Boolean);
}

/**
 * True when the called line DID is the Sally sales/demo/Twilio number.
 * Exact national-digit match only (no endsWith) — short fragments must not steal restaurant DIDs.
 */
export function isSallyInboundLine(calledNumber?: string | null): boolean {
  const called = phoneDigitsForMatch(calledNumber || '');
  // UK national (no leading 0/44): mobiles 10 digits, most geos 9–10.
  if (!called || called.length < 9) return false;
  return listSallyInboundNumbers().some((candidate) => {
    const digits = phoneDigitsForMatch(candidate);
    if (!digits || digits.length < 9) return false;
    return digits === called;
  });
}

/** Sally may warm-transfer only when explicitly enabled (default: blocked). */
export function isSallyTransferAllowed(): boolean {
  return String(process.env.SALLY_ALLOW_TRANSFER || '').trim() === '1';
}

export function resolveSallyWebsiteUrl(): string {
  const raw = (
    process.env.SALLY_WEBSITE_URL?.trim()
    || process.env.APP_BASE_URL?.trim()
    || 'https://sync2dine.io'
  );
  return raw.replace(/\/+$/, '');
}

export function isSallySalesCall(
  meta?: Record<string, unknown> | null,
  opts?: { campaignTemplate?: string; agentPersona?: string; lineDid?: string },
): boolean {
  const m = meta || {};
  const persona = String(opts?.agentPersona || m.agentPersona || '').toLowerCase();
  if (persona === SALLY_PERSONA) return true;
  if (String(m.aim || '').toLowerCase() === 'sales_outreach') return true;
  if (String(m.source || '').toLowerCase() === 'sales_csv_dial') return true;
  const lineDid = opts?.lineDid ?? (m.lineDid != null ? String(m.lineDid) : '');
  if (isSallyInboundLine(lineDid)) return true;
  return false;
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
    `Demo line: ${spokenDemoPhone}. Always say that number aloud.`,
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
    `- Demo phone: ${offer.demoPhone} — speak as: ${offer.spokenDemoPhone}`,
    ...(offer.packageLines as string[]).map((l) => `- ${l}`),
    '- USPs Judie: full order/booking into app; overflow/after-hours; you are the product voice.',
    '- USPs Atmosphere (sell hard — from sync2dine.io + product truth):',
    '  • Only company in England doing this strategic venue audio — manages the room for revenue, not a music stream.',
    '  • Front of house: advertise to people already inside (specials, birthday parties, catering); example free-dip-for-review+share photo.',
    '  • Day-to-day announcements (open/close), curated genre/brand playlists, volume monitor/control.',
    '  • Back of house: kitchen training, rules, motivation, staff-genre music while they work.',
    '  • Easy: app + connect phone/audio and it keeps running. Return often shows in the first weeks.',
    '- Complete = Atmosphere + Judie Starter — best value upsell (phone + room).',
  ];
  return lines.join('\n');
}

function formatObjectionPlaybook(): string {
  return [
    'OBJECTIONS (short Cockney answers, then ask a closing question):',
    '- Already have a receptionist: Judie covers missed/overflow/after-hours and takes full orders into the app.',
    '- Afraid of unlimited bills: Clear weekly allowance + published overage — no unlimited minutes sold.',
    '- What if Judie fails: Transfer-to-human on the restaurant line; staff stay in control. On this sales call do not take diner orders.',
    '- Too expensive: Launch rates; Complete saves vs buying both; ask which hours are busiest to size minutes.',
  ].join('\n');
}

const SALLY_SALES_OS = [
  'You are Sally, Sync2Dine’s dedicated sales AI (phone).',
  'IDENTITY: On this sales channel your name is Sally. You are the same person / same voice as Judie under a sales name. You may say “Judie’s basically me — you’re hearing what customers get” / “I’m calling to sell myself.” Never say Cynthia, Lizzie, or Builder Diddies.',
  'BRAINS: This call is the SALES brain only. After they buy, diners get Judie with order tools. Do NOT take food orders on this call.',
  'AIM: Close — signed interest / signup / paying customer. Inquiry alone is not success. Prefer “shall I sign you up now?” over booking a callback.',
  'HOW: Discovery → USP Atmosphere (rich pitch) → USP Judie (that’s me) → upsell Complete → MUST call getOfferTerms before prices → speak demo number clearly → hard close / signup → capture missing fields only (venue, name, email, mobile; postcode only if missing).',
  'VOICE & HUMOUR (always — invent jokes yourself; no joke script):',
  '- Thick common Cockney / London market-trader energy — NOT RP, NOT soft/call-centre. Thickness preferred over clarity EXCEPT for IDs.',
  '- Banter words: "lovely", "sorted", "cheers", sparingly "innit", "you\'re having a laugh", "get in", "look", "right". Never American.',
  '- Extra funny: invent a joke or cheeky aside most turns. A little rude: sharp, teasing, sarky — never abusive or cruel.',
  '- Phone: one or two spoken sentences per turn. Simple closes ~6–7 minutes; stay up to 15–20 minutes if they want package detail — do not rush off.',
  '- Dial humour down only for DNC/opt-out, angry callers, or money/legal stress.',
  'CLARITY FOR IDs (overrides Cockney thickness):',
  '- Demo phone: use spokenDemoPhone from getOfferTerms (digit groups). Repeat once if asked.',
  '- Postcodes: ONLY when newly collected or caller corrects — one speakUkPostcode readback (Quebec/Whisky for Q/W). If CRM/brief already has venue + postcode, do NOT ask or NATO-read again.',
  '- Prefer CRM mobile if present; only reconfirm phone when they give a different number.',
  '- Never claim email/SMS/WhatsApp sent unless the tool returned success.',
  'MESSAGING:',
  '- Prefer email when they give an email — MUST call sendSalesFollowUp with channel email before saying you sent it.',
  '- SMS only to a UK mobile (07…). If on a landline, ask for their mobile before SMS.',
  '- Do not default to WhatsApp. If WhatsApp fails, say so and offer email/SMS/speak the number.',
  'CALLBACKS:',
  '- Only book a callback if they refuse signup or ask for one. Then MUST call bookCallback or bookDemo with preferredTime as ISO (Europe/London). Never claim booked without tool success.',
  'STAFFING (this sales/demo line):',
  '- This line is AI-staffed. You own the call end-to-end. Humans are not available on this number.',
  '- Do NOT offer to transfer or put them through to a person. Never volunteer transfer.',
  '- If they insist on a human: take a message (captureMessage) or bookCallback / bookDemo — keep closing yourself. Do not dial transfer.',
  '- transferToHuman / transferCall exist only as a dormant last-resort capability; default behaviour is NEVER use them.',
  'GUARDRAILS:',
  '- NOT the restaurant food-order agent.',
  '- Products: Judie and/or Atmosphere (+ Complete). Sally is not a separate SKU.',
  '- Never invent price — use getOfferTerms.',
  '- Never address Guest or Unknown.',
  '- LARGE CONTRACT / multi-site: arrange callback yourself — do not transfer.',
  '- DNC/opt-out = stop. When finished, native hang-up.',
].join('\n');

const SALLY_PHONE_CLOSE_SCRIPT = [
  'SPOKEN SALES SCRIPT (use tools — do not just chat):',
  '1. Open — cheeky hook, greet by name if known.',
  '2. Discovery — missed calls vs room/audio (~60–90s).',
  '3. USP Atmosphere — only-in-England strategic audio; in-venue ads (specials/parties/catering); free-dip review+share story; open/close announcements; volume control; kitchen training/motivation music; app connect-and-run.',
  '4. USP Judie — “that’s me” — full orders/bookings so staff aren’t on the phone.',
  '5. Upsell Complete — weekly launch; “you know it makes sense”.',
  '6. MUST getOfferTerms — walk Judie Starter / Atmosphere / Complete / Pro if busy; help size minutes to their hours.',
  '7. Demo — speak spokenDemoPhone aloud; MUST sendSalesFollowUp email when they give email (ask mobile if landline for SMS).',
  '8. Hard close — “Shall I sign you up now?” → collect only missing fields (name, email, mobile). Venue/postcode: use CRM/brief if present — do not reconfirm postcode unless new or corrected → captureLead / bookDemo.',
  '9. Confirm what tools successfully sent. Only use callback if they push back — then bookCallback with ISO preferredTime.',
].join('\n');

const GET_OFFER_TERMS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'getOfferTerms',
    description:
      'Read authoritative Sync2Dine packages, weekly prices, USPs, and demo phone (with spokenDemoPhone). Call BEFORE quoting any price.',
    parameters: { type: 'object', properties: {} },
  },
};

const BOOK_DEMO_TOOL = {
  type: 'function' as const,
  function: {
    name: 'bookDemo',
    description:
      'Persist a Sync2Dine demo/callback: CRM lead + scheduled outbound. Pass when as ISO datetime when possible (e.g. tomorrow 16:00 London).',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string', description: 'Preferred time — ISO preferred, or plain English like tomorrow 4pm' },
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        restaurant: { type: 'string' },
        postcode: { type: 'string' },
        notes: { type: 'string' },
      },
    },
  },
};

const SEND_SALES_FOLLOW_UP_TOOL = {
  type: 'function' as const,
  function: {
    name: 'sendSalesFollowUp',
    description:
      'Email and/or SMS the prospect the website, demo number, and a short pricing/demo note. Prefer email. SMS only to UK mobiles. Never claim success without this tool succeeding.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['email', 'sms', 'both'] },
        toEmail: { type: 'string' },
        toMobile: { type: 'string', description: 'UK mobile E.164 or 07… for SMS' },
        subject: { type: 'string' },
        body: { type: 'string' },
        includeDemoPhone: { type: 'boolean' },
      },
      required: ['channel'],
    },
  },
};

/** Present for tool parity; default handler blocks dial — use takeMessage / bookCallback instead. */
const SALLY_TRANSFER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'transferToHuman',
    description:
      'This sales/demo line is AI-staffed. Do NOT use to dial a human. Set takeMessage true to leave a message, or prefer bookCallback/bookDemo. Transfer dials are blocked unless ops enables SALLY_ALLOW_TRANSFER.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        department: { type: 'string', enum: ['sales', 'projects', 'recruitment', 'accounts', 'general'] },
        takeMessage: { type: 'boolean' },
        message: { type: 'string' },
      },
      required: ['reason'],
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
    SALLY_TRANSFER_TOOL,
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
}): { instructions: string; language: 'en' } {
  const contact = String(input.contactName || '').trim();
  const safeName = contact && !/^(guest|unknown|unknown caller)$/i.test(contact) ? contact : '';
  const onMobile = isUkMobile(input.partyPhone);
  const instructions = [
    SALLY_SALES_OS,
    buildSallyPhoneVoiceOverlay(),
    formatOfferFactsBlock(),
    formatObjectionPlaybook(),
    SALLY_PHONE_CLOSE_SCRIPT,
    '- CLARITY: Postcode NATO readback only when newly spoken or corrected — skip if CRM/brief already has venue + postcode.',
    input.direction === 'outbound'
      ? '- This is an outbound sales call you placed — work the close script.'
      : '- This is an inbound sales/demo callback — they likely got your SMS or website number. Greet as Sally, then work the close script. Do not transfer to a human.',
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
      : '- Pitch Sync2Dine: Judie (me) answers the phone; Atmosphere runs the room; Complete does both — then close.',
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
    const website = resolveSallyWebsiteUrl();
    const includeDemo = input.includeDemoPhone !== false;
    const demoNational = toUkNationalDigits(demoPhone) || demoPhone;
    const defaultBody = [
      'Hi — Sally from Sync2Dine here.',
      `Website: ${website}`,
      includeDemo
        ? `Call me on the demo line: ${demoNational} (${spoken}). Ask for Sally — I answer this number.`
        : '',
      'Judie takes full orders; Atmosphere runs venue audio. Complete does both.',
      'Reply to this message or call the number above and we can get you signed up.',
      String(input.body || '').trim(),
    ]
      .filter(Boolean)
      .join('\n\n');
    const subject = String(input.subject || 'Sync2Dine — website, demo number + next steps').trim();
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

    // CRM proof — do not rely on empty mailbox messages[]
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
          ? `Sent by ${sentVia.join(' and ')}. Demo line again: ${spoken}.`
          : `Could not send (${errors.join(', ') || 'unknown'}). Say the demo number aloud: ${spoken}. Ask for email or a mobile for SMS.`,
    };
  }

  if (name === 'bookDemo') {
    const whenRaw = String(input.when || '').trim();
    const iso = whenRaw ? resolveCallbackIso(whenRaw) : null;
    const phone = String(input.phone || ctx.partyPhone || '').trim();
    const restaurant = String(input.restaurant || '').trim();
    const postcode = String(input.postcode || '').trim();
    const email = String(input.email || '').trim();
    const personName = String(input.name || restaurant || 'Prospect').trim() || 'Prospect';
    const notes = [
      String(input.notes || '').trim(),
      restaurant ? `Venue: ${restaurant}` : '',
      postcode ? `Postcode: ${postcode}` : '',
      whenRaw ? `Requested: ${whenRaw}` : '',
      iso ? `Scheduled ISO: ${iso}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const lead = captureOrUpdateLead(
      {
        name: personName,
        phone,
        email: email || undefined,
        address: postcode || restaurant || undefined,
        postcode: postcode || undefined,
        notes: notes || 'Sally bookDemo',
        scope: restaurant ? `Demo — ${restaurant}` : 'Sync2Dine demo/callback',
      },
      { callId: ctx.callId, fallbackPhone: ctx.partyPhone },
    );

    if (lead.error) {
      return {
        ok: false,
        booked: false,
        error: lead.error,
        spokenHint: lead.spokenHint || 'I need a phone number to book that demo.',
      };
    }

    const customerId = String(lead.customer.id || '');
    let jobId: string | undefined;
    if (phone) {
      const dialTo = toE164Uk(phone);
      const job = enqueueOutboundCall({
        to: dialTo,
        template: 'lead_callback',
        status: 'queued',
        context: {
          name: personName,
          reason: notes || 'Sally booked demo/callback',
          preferredTime: whenRaw || iso,
          customerId,
          aim: 'demo_book',
          agentPersona: SALLY_PERSONA,
          restaurant,
          postcode,
          email,
          callId: ctx.callId,
        },
        scheduledAt: iso || undefined,
      });
      jobId = String(job.id);
    }

    if (customerId && iso) {
      const store = getDataStore();
      const idx = store.customers.findIndex((c) => String(c.id) === customerId);
      if (idx >= 0) {
        const prev = store.customers[idx];
        store.customers[idx] = {
          ...prev,
          nextFollowUp: iso,
          address: postcode || restaurant || prev.address,
          email: email || prev.email,
          notes: [prev.notes, notes].filter(Boolean).join(' | '),
          // Keep contact name; stash venue in notes already. Prefer restaurant as display if name was generic.
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
        summary: `Demo/callback booked${whenRaw ? `: ${whenRaw}` : ''}${iso ? ` (${iso})` : ''}`,
        detail: notes,
        aim: 'demo_book',
        type: 'callback',
        createdBy: 'sally',
      });
    } else if (customerId && (restaurant || postcode || email)) {
      const store = getDataStore();
      const idx = store.customers.findIndex((c) => String(c.id) === customerId);
      if (idx >= 0) {
        const prev = store.customers[idx];
        store.customers[idx] = {
          ...prev,
          address: postcode || restaurant || prev.address,
          email: email || prev.email,
          notes: [prev.notes, notes].filter(Boolean).join(' | '),
          name: restaurant && (!prev.name || String(prev.name).toLowerCase() === 'dolab')
            ? `${prev.name || personName} — ${restaurant}`
            : prev.name,
        };
        syncData(store);
      }
    }

    try {
      sendToStaffCynthiaInternal({
        title: 'Sally — demo/callback booked',
        customerName: personName,
        phone,
        address: [restaurant, postcode].filter(Boolean).join(', ') || undefined,
        summary: whenRaw || iso || 'Demo/callback requested',
        notes,
        customerId: customerId || undefined,
        source: 'phone',
      });
    } catch {
      /* notify best-effort */
    }

    return {
      ok: true,
      booked: true,
      customerId,
      jobId,
      scheduledAt: iso,
      spokenPostcode: postcode ? speakUkPostcode(postcode) : undefined,
      spokenHint: iso
        ? `Booked for ${whenRaw || iso}. I've logged ${restaurant || personName}${postcode ? ` at ${speakUkPostcode(postcode)}` : ''}.`
        : `Logged the demo request for ${restaurant || personName}. Confirm a time if you still need one.`,
    };
  }

  return { ok: false, error: `Unknown Sally phone tool: ${name}` };
}

/** Staff notify helper for end-of-call Sally finalize (Sync2Dine CRM primary). */
export function notifySallyCallEnded(opts: {
  callId: string;
  customerId?: string | null;
  partyPhone: string;
  summary: string;
  disposition?: string;
}): void {
  const store = getDataStore();
  const cust = opts.customerId
    ? store.customers.find((c) => String(c.id) === opts.customerId)
    : undefined;
  const follow = cust?.nextFollowUp ? String(cust.nextFollowUp) : '';
  const notes = [
    follow ? `Callback / follow-up: ${follow}` : '',
    opts.disposition ? `Disposition: ${opts.disposition}` : '',
    cust?.address ? `Address/postcode: ${String(cust.address)}` : '',
    cust?.email ? `Email: ${String(cust.email)}` : '',
    `Call: ${opts.callId}`,
  ]
    .filter(Boolean)
    .join('\n');

  // Primary: CRM Call Centre activity (Sync2Dine — no Cynthia branding required)
  if (opts.customerId) {
    try {
      appendCustomerCallActivity({
        customerId: String(opts.customerId),
        callId: opts.callId,
        summary: `Sally sales call ended${follow ? ` · follow-up ${follow}` : ''}`,
        detail: [opts.summary.slice(0, 400), notes].filter(Boolean).join(' | ').slice(0, 800),
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

  // Secondary: Sync2Dine staff-card pipe (legacy name Cynthia — writes Sync2Dine home org only)
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
