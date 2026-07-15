/**
 * TradePro Soho66 SIP bridge — two-way Aria conversation.
 *
 * Env:
 *   SIP_BRIDGE_PORT=3100
 *   SIP_BRIDGE_SIP_PORT=50670
 *   WEBHOOK_BASE_URL=http://127.0.0.1:3001
 *   SIP_BRIDGE_PUBLIC_IP=192.168.x.x
 *   VOICE_MODE=realtime | pipeline   (default realtime)
 *   REALTIME_MODEL=gpt-4o-realtime-preview
 *   REALTIME_VOICE=coral
 */
const http = require('http');
const { URL } = require('url');
const { SipStack } = require('./sip-ua');
const { silenceMulaw, mulawToWav } = require('./audio');
const { startUpnpRefresh } = require('./upnp');
const { runRealtimeConversation } = require('./realtime');

const PORT = Number(process.env.SIP_BRIDGE_PORT || 3100);
const MAX_TURNS = Number(process.env.SIP_BRIDGE_MAX_TURNS || 20);
const VOICE_MODE = String(process.env.VOICE_MODE || 'realtime').trim().toLowerCase();
const stack = new SipStack();
let stopUpnp = () => {};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function fetchMulawAudio(playUrl, speakText, webhookBase) {
  if (playUrl) {
    try {
      const url = new URL(playUrl);
      url.searchParams.set('format', 'mulaw');
      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(45000) });
      if (r.ok) {
        const ct = r.headers.get('content-type') || '';
        const buf = Buffer.from(await r.arrayBuffer());
        if (!ct.includes('mpeg') && !ct.includes('mp3') && buf.length > 80) {
          console.log('[bridge] TTS mulaw bytes=', buf.length);
          return buf;
        }
      }
    } catch (e) {
      console.warn('[bridge] playUrl fetch failed', e.message);
    }
  }

  if (speakText && webhookBase) {
    try {
      const url = new URL(`${webhookBase.replace(/\/$/, '')}/api/agent/tts`);
      url.searchParams.set('text', speakText.slice(0, 800));
      url.searchParams.set('format', 'mulaw');
      url.searchParams.set('voiceId', 'fable');
      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(45000) });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        console.log('[bridge] text TTS mulaw bytes=', buf.length);
        return buf;
      }
    } catch (e) {
      console.warn('[bridge] text TTS failed', e.message);
    }
  }

  return silenceMulaw(800);
}

async function transcribeMulaw(mulawBuf, webhookBase) {
  if (!mulawBuf || mulawBuf.length < 1600) return '';
  const wav = mulawToWav(mulawBuf, 8000);
  try {
    const r = await fetch(`${webhookBase.replace(/\/$/, '')}/api/agent/stt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        Accept: 'application/json',
      },
      body: wav,
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.warn('[bridge] STT status', r.status, err.slice(0, 200));
      return '';
    }
    const json = await r.json();
    return String(json.text || '').trim();
  } catch (e) {
    console.warn('[bridge] STT failed', e.message);
    return '';
  }
}

function firstSentence(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const m = t.match(/^(.+?[.!?])(?:\s+|$)/);
  return m ? m[1].trim() : t.slice(0, 180);
}

async function runConversation({
  session,
  callId,
  to,
  from,
  webhookUrl,
  gatherActionUrl,
  webhookBase,
  initialSpeak,
  initialPlayUrl,
}) {
  let speak = initialSpeak;
  let playUrl = initialPlayUrl;
  let turnUrl = gatherActionUrl
    || `${webhookBase.replace(/\/$/, '')}/webhooks/voice/turn?callId=${encodeURIComponent(callId)}`;

  // Opening — keep RTP flowing the whole time
  session.startIdle();
  const openAudio = await fetchMulawAudio(playUrl, speak, webhookBase);
  console.log('[bridge] opener bytes=', openAudio.length, 'speak=', String(speak || '').slice(0, 80));
  await session.playMulaw(openAudio);
  session.startIdle();
  console.log('[bridge] opener played', callId);

  let emptyListens = 0;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (session.isAlive && !session.isAlive()) break;

    console.log('[bridge] listening turn', turn + 1);
    // Gentle VAD — do not cut the caller off mid-sentence
    const mulaw = await session.listenUtterance({
      maxMs: 20000,
      silenceMs: 1400,
      minSpeechMs: 500,
      energyThreshold: 70,
      prerollMs: 600,
    });

    session.startIdle();

    const text = await transcribeMulaw(mulaw, webhookBase);
    console.log('[bridge] STT=', JSON.stringify(text), 'audioBytes=', mulaw.length);

    if (!text) {
      emptyListens += 1;
      // Never hard hang up on silence — prompt and keep listening until they hang up
      if (emptyListens === 1 || emptyListens === 3) {
        const nudge = await fetchMulawAudio(
          null,
          emptyListens === 1
            ? "Sorry, I didn't catch that. Go ahead whenever you're ready."
            : "I'm still here — take your time.",
          webhookBase,
        );
        await session.playMulaw(nudge);
        session.startIdle();
      }
      if (emptyListens >= 8) {
        const bye = await fetchMulawAudio(null, "I'll leave it there for now. Feel free to call us anytime. Bye!", webhookBase);
        await session.playMulaw(bye);
        break;
      }
      continue;
    }
    emptyListens = 0;

    // Immediate spoken ack so the caller always hears something while the brain thinks
    const ackAudio = await fetchMulawAudio(null, 'Okay.', webhookBase);
    await session.playMulaw(ackAudio);
    session.startIdle();

    let replySpeak = "I'm with you — how can I help?";
    let replyPlay;
    let hangup = false;

    try {
      const wr = await fetch(turnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'speech_turn',
          callId,
          providerCallId: session.providerCallId,
          from: from || '',
          to,
          direction: 'outbound',
          speechResult: text,
          status: 'in_progress',
        }),
        signal: AbortSignal.timeout(60000),
      });
      const raw = await wr.text();
      console.log('[bridge] turn status', wr.status, raw.slice(0, 280));
      try {
        const json = JSON.parse(raw);
        if (json.speak) replySpeak = String(json.speak);
        if (json.playUrl) replyPlay = String(json.playUrl);
        if (json.gatherActionUrl) turnUrl = String(json.gatherActionUrl);
        hangup = Boolean(json.hangup);
      } catch {
        /* non-json */
      }
    } catch (e) {
      console.warn('[bridge] turn failed', e.message);
      replySpeak = "Sorry, I'm having a little trouble. Could you repeat that?";
    }

    const replyAudio = await fetchMulawAudio(replyPlay, replySpeak, webhookBase);
    console.log('[bridge] reply play bytes=', replyAudio.length, 'speak=', replySpeak.slice(0, 80));
    await session.playMulaw(replyAudio);
    session.startIdle();
    // Brief pause so the last syllable isn't clipped on the far end
    await new Promise((r) => setTimeout(r, 250));

    if (hangup) break;
  }

  try {
    session.hangup();
    console.log('[bridge] hung up', callId);
  } catch {
    /* ignore */
  }
}

async function handleOutboundCall(body) {
  const to = String(body.to || '').trim();
  const callId = String(body.callId || `bridge-${Date.now()}`);
  const lineId = body.lineId ? String(body.lineId) : undefined;
  const webhookUrl = String(body.webhookUrl || '').trim();
  const from = String(body.from || '').trim();
  if (!to) {
    const err = new Error('to is required');
    err.status = 400;
    throw err;
  }
  if (!webhookUrl) {
    const err = new Error('webhookUrl is required');
    err.status = 400;
    throw err;
  }

  console.log('[bridge] dial', to, 'callId=', callId, 'lineId=', lineId);

  const session = await stack.placeCall({ to, lineId, displayName: 'Aria' });

  const line = stack.getLine(lineId);
  const webhookBase =
    (line && line.webhookBaseUrl)
    || process.env.WEBHOOK_BASE_URL
    || 'http://127.0.0.1:3001';

  // Notify TradePro outbound webhook for AI opener
  let speak = 'Hello, this is Aria from TradePro.';
  let playUrl;
  let gatherActionUrl;
  try {
    const wr = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'call_started',
        callId,
        providerCallId: session.providerCallId,
        from,
        to,
        direction: 'outbound',
        status: 'in_progress',
      }),
      signal: AbortSignal.timeout(60000),
    });
    const text = await wr.text();
    console.log('[bridge] webhook status', wr.status, text.slice(0, 300));
    try {
      const json = JSON.parse(text);
      if (json.speak) speak = String(json.speak);
      if (json.playUrl) playUrl = String(json.playUrl);
      if (json.gatherActionUrl) gatherActionUrl = String(json.gatherActionUrl);
    } catch {
      /* non-json */
    }
  } catch (e) {
    console.warn('[bridge] webhook failed', e.message);
  }

  // Conversation runs in background so /calls returns quickly after answer+webhook
  setImmediate(() => {
    const onErr = (err) => {
      console.error('[bridge] conversation error', err);
      try {
        session.hangup();
      } catch {
        /* ignore */
      }
    };

    if (VOICE_MODE === 'pipeline') {
      console.log('[bridge] VOICE_MODE=pipeline (STT/GPT/TTS)');
      runConversation({
        session,
        callId,
        to,
        from,
        webhookUrl,
        gatherActionUrl,
        webhookBase,
        initialSpeak: speak,
        initialPlayUrl: playUrl,
      }).catch(onErr);
      return;
    }

    console.log('[bridge] VOICE_MODE=realtime (OpenAI Realtime speech-to-speech)');
    // Realtime owns greet + turns; skip canned opener play to avoid double greeting
    runRealtimeConversation({
      session,
      callId,
      to,
      from,
      direction: 'outbound',
      webhookBase,
    }).catch(onErr);
  });

  return { callId, sid: session.providerCallId, status: 'in_progress' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  try {
    if (pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        service: 'tradepro-sip-bridge',
        sipPort: stack.sipPort,
        lines: stack.listLines().length,
        twoWay: true,
        voiceMode: VOICE_MODE,
      });
      return;
    }

    if (pathname === '/lines' && req.method === 'GET') {
      sendJson(res, 200, { lines: stack.listLines() });
      return;
    }

    if (pathname === '/lines/register' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      const lineId = String(body.lineId || '').trim();
      if (!lineId || !body.sipUsername || !body.sipPassword) {
        sendJson(res, 400, { error: 'lineId, sipUsername, sipPassword required' });
        return;
      }
      const result = await stack.registerLine({
        lineId,
        sipUsername: String(body.sipUsername),
        sipPassword: String(body.sipPassword),
        sipDomain: String(body.sipDomain || process.env.SOHO66_SIP_DOMAIN || 'sbc.soho66.co.uk'),
        did: String(body.did || ''),
        webhookBaseUrl: String(body.webhookBaseUrl || process.env.WEBHOOK_BASE_URL || 'http://127.0.0.1:3001'),
      });
      if (!result.ok) {
        sendJson(res, 502, { error: result.message || 'register failed' });
        return;
      }
      sendJson(res, 200, { ok: true, message: result.message, lineId });
      return;
    }

    const delMatch = pathname.match(/^\/lines\/([^/]+)$/);
    if (delMatch && req.method === 'DELETE') {
      stack.unregisterLine(decodeURIComponent(delMatch[1]));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/calls' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      const result = await handleOutboundCall(body);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[bridge] error', err);
    sendJson(res, err.status || 500, { error: err.message || 'Internal error' });
  }
});

server.listen(PORT, async () => {
  try {
    await stack.ensurePublicIp();
  } catch {
    /* keep constructor IP */
  }
  stopUpnp = startUpnpRefresh({
    sipPort: stack.sipPort,
    rtpPortBase: stack.rtpPortBase,
    span: 40,
    everyMs: 45000,
  });
  stack.start();
  console.log(`TradePro SIP bridge HTTP :${PORT} (SIP udp/${stack.sipPort}) public=${stack.ip} two-way=on`);
});

process.on('SIGINT', () => {
  try { stopUpnp(); } catch { /* ignore */ }
  process.exit(0);
});
