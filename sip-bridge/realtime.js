/**
 * OpenAI Realtime GA (speech-to-speech) client for TradePro SIP bridge.
 * Streams G.711 μ-law (audio/pcmu) both ways; tools + transcripts via TradePro API.
 */
const WebSocket = require('ws');

function postJson(url, body, timeoutMs = 30000) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (r) => {
    const text = await r.text();
    let json = {};
    try {
      json = JSON.parse(text || '{}');
    } catch {
      json = { raw: text };
    }
    if (!r.ok) {
      const err = new Error(json.error || `HTTP ${r.status}`);
      err.status = r.status;
      err.body = json;
      throw err;
    }
    return json;
  });
}

/**
 * Run a Realtime session bridged to an answered SIP RTP session.
 * @returns {Promise<void>} resolves when the call/session ends
 */
async function runRealtimeConversation({
  session,
  callId,
  to,
  from,
  direction = 'outbound',
  webhookBase,
  campaignTemplate,
}) {
  const base = String(webhookBase || '').replace(/\/$/, '');
  if (!base) throw new Error('webhookBase required');

  console.log('[realtime] fetching session config', callId);
  const cfg = await postJson(`${base}/api/agent/realtime/session`, {
    callId,
    to,
    from,
    direction,
    campaignTemplate,
    providerCallId: session.providerCallId,
  }, 45000);

  const apiKey = cfg.apiKey;
  let model = cfg.model || process.env.REALTIME_MODEL || 'gpt-realtime';
  // Force GA model if API/env still returns retired preview id
  if (/realtime-preview/i.test(model) || model === 'gpt-4o-realtime-preview') {
    model = 'gpt-realtime';
  }
  const voice = cfg.voice || process.env.REALTIME_VOICE || 'coral';
  if (!apiKey) throw new Error('realtime session missing apiKey');

  // GA: no OpenAI-Beta header (beta shape is disabled)
  const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  console.log('[realtime] connecting', model, 'voice=', voice);

  const ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  let closed = false;
  let pendingToolBatch = 0;
  let unsubInbound = null;

  const closeAll = (reason) => {
    if (closed) return;
    closed = true;
    console.log('[realtime] closing', reason || '');
    try { ws.close(); } catch { /* ignore */ }
    try { session.stopDuplex?.(); } catch { /* ignore */ }
    try { unsubInbound?.(); } catch { /* ignore */ }
  };

  const sendEvent = (obj) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('[realtime] send failed', e.message);
    }
  };

  const persistTranscript = async (role, text) => {
    const t = String(text || '').trim();
    if (!t) return;
    try {
      await postJson(`${base}/api/agent/realtime/transcript`, {
        callId,
        role,
        text: t,
        to,
        from,
        direction,
      });
    } catch (e) {
      console.warn('[realtime] transcript persist failed', e.message);
    }
  };

  const handleToolCall = async (callIdFc, name, argsJson) => {
    console.log('[realtime] tool', name, String(argsJson || '').slice(0, 120));
    pendingToolBatch += 1;
    let output = { error: 'tool failed' };
    try {
      const result = await postJson(`${base}/api/agent/realtime/tool`, {
        callId,
        name,
        arguments: argsJson,
        to,
        from,
        direction,
      });
      output = result.output ?? result;
      if (output && (output.shouldHangup || (output.ended && name === 'endCall'))) {
        try { session.hangup?.(); } catch { /* ignore */ }
        closeAll('agent_endCall');
      }
    } catch (e) {
      output = { error: e.message };
    }
    sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callIdFc,
        output: JSON.stringify(output),
      },
    });
    pendingToolBatch -= 1;
    if (pendingToolBatch <= 0 && !closed) {
      pendingToolBatch = 0;
      sendEvent({ type: 'response.create' });
    }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Realtime WS connect timeout')), 20000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  // GA session shape
  sendEvent({
    type: 'session.update',
    session: {
      type: 'realtime',
      model,
      instructions: cfg.instructions,
      output_modalities: ['audio'],
      tools: Array.isArray(cfg.tools) ? cfg.tools : [],
      tool_choice: 'auto',
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          transcription: { model: 'whisper-1', language: 'en' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
        },
        output: {
          format: { type: 'audio/pcmu' },
          voice,
        },
      },
    },
  });

  // Continuous duplex RTP — always receive + always send (NAT pinhole)
  session.stopIdle?.();
  session.startDuplex?.();

  unsubInbound = session.onInboundFrame
    ? session.onInboundFrame((payload) => {
      if (closed || !payload?.length) return;
      sendEvent({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(payload).toString('base64'),
      });
    })
    : null;

  // Nudge assistant to greet after connect (outbound)
  setTimeout(() => {
    if (closed) return;
    sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: direction === 'outbound'
            ? 'The outbound phone call just connected. Greet them warmly in one short spoken sentence using account memory. Do not wait for them to speak first.'
            : 'An inbound phone call just connected. Greet them warmly in one short spoken sentence.',
        }],
      },
    });
    sendEvent({ type: 'response.create' });
  }, 400);

  await new Promise((resolve) => {
    ws.on('message', (raw) => {
      let evt;
      try {
        evt = JSON.parse(String(raw));
      } catch {
        return;
      }
      const type = evt.type;

      if (type === 'error') {
        console.error('[realtime] error event', JSON.stringify(evt.error || evt).slice(0, 500));
        return;
      }

      if (type === 'session.updated' || type === 'session.created') {
        console.log('[realtime]', type);
        return;
      }

      if (type === 'input_audio_buffer.speech_started') {
        // Barge-in: stop speaking immediately
        session.clearOutbound?.();
        console.log('[realtime] barge-in / speech_started');
        return;
      }

      // GA + legacy audio deltas
      if (
        type === 'response.output_audio.delta'
        || type === 'response.audio.delta'
      ) {
        const b64 = evt.delta;
        if (b64) {
          try {
            session.enqueueMulaw?.(Buffer.from(b64, 'base64'));
          } catch (e) {
            console.warn('[realtime] enqueue audio failed', e.message);
          }
        }
        return;
      }

      if (
        type === 'response.output_audio_transcript.done'
        || type === 'response.audio_transcript.done'
      ) {
        const transcript = evt.transcript || '';
        console.log('[realtime] assistant=', JSON.stringify(String(transcript).slice(0, 160)));
        void persistTranscript('assistant', transcript);
        return;
      }

      if (type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = evt.transcript || '';
        console.log('[realtime] user=', JSON.stringify(String(transcript).slice(0, 160)));
        void persistTranscript('user', transcript);
        return;
      }

      if (type === 'response.function_call_arguments.done') {
        const fcId = evt.call_id;
        const name = evt.name;
        const args = evt.arguments;
        if (fcId && name) {
          void handleToolCall(fcId, name, args);
        }
        return;
      }

      if (type === 'response.output_item.done' && evt.item?.type === 'function_call') {
        const item = evt.item;
        if (item.call_id && item.name) {
          void handleToolCall(item.call_id, item.name, item.arguments);
        }
      }
    });

    ws.on('close', (code, reason) => {
      console.log('[realtime] ws closed', code, String(reason || ''));
      closeAll('ws-close');
      resolve();
    });

    ws.on('error', (err) => {
      console.error('[realtime] ws error', err.message);
      closeAll('ws-error');
      resolve();
    });

    const watchdog = setInterval(() => {
      if (closed) {
        clearInterval(watchdog);
        return;
      }
      if (session.isAlive && !session.isAlive()) {
        clearInterval(watchdog);
        closeAll('call-ended');
        resolve();
      }
    }, 1000);
  });

  closeAll('done');
}

module.exports = { runRealtimeConversation };
