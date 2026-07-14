/**
 * Bidirectional RTP session: send μ-law TTS + receive for VAD listen.
 */
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { silenceMulaw, mulawFrameEnergy } = require('./audio');

const FRAME_SAMPLES = 160;
const FRAME_MS = 20;

class RtpSession extends EventEmitter {
  constructor({ remoteIp, remotePort, localPort = 0 }) {
    super();
    this.remoteIp = remoteIp;
    this.remotePort = remotePort;
    this.socket = dgram.createSocket('udp4');
    this.ssrc = (Math.random() * 0xffffffff) >>> 0;
    this.seq = (Math.random() * 0xffff) >>> 0;
    this.timestamp = (Math.random() * 0xffffffff) >>> 0;
    this.localPort = localPort;
    this._timer = null;
    this._idleTimer = null;
    this._queue = Buffer.alloc(0);
    this._playing = false;
    this._idle = false;
    this._bound = false;
    this._inboundLogged = false;
    this._listenBuf = [];
    this._listening = false;
    this._rxPackets = 0;
    this._rxBytes = 0;
    this._ignoreInbound = false;
    this._markerNext = true;
    this._latchEnabled = true;
  }

  /** Reset counters after SIP 200 OK so we can tell early-media from live call audio. */
  markAnswered() {
    this._rxPackets = 0;
    this._rxBytes = 0;
    this._inboundLogged = false;
    this._answerAt = Date.now();
  }

  getRxPackets() {
    return this._rxPackets || 0;
  }

  async bind() {
    if (this._bound) return this.localPort;
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.localPort, '0.0.0.0', () => {
        this.socket.removeListener('error', reject);
        this.localPort = this.socket.address().port;
        this._bound = true;
        resolve();
      });
    });
    this.socket.on('message', (msg, rinfo) => this._onRtp(msg, rinfo));
    return this.localPort;
  }

  _onRtp(msg, rinfo) {
    if (msg.length < 12) return;
    const payload = msg.subarray(12);
    if (!payload.length) return;
    this._rxPackets = (this._rxPackets || 0) + 1;
    this._rxBytes = (this._rxBytes || 0) + payload.length;
    // Symmetric RTP: always latch onto the address packets actually come from
    // (Soho media farm often differs from SDP c= line).
    if (this._latchEnabled !== false && rinfo?.address && rinfo?.port) {
      const changed =
        this.remoteIp !== rinfo.address || Number(this.remotePort) !== Number(rinfo.port);
      if (changed) {
        console.log(
          '[rtp] latch remote',
          `${this.remoteIp}:${this.remotePort}`,
          '->',
          `${rinfo.address}:${rinfo.port}`,
        );
        this.remoteIp = rinfo.address;
        this.remotePort = rinfo.port;
      }
    }
    // Never drop receive path — ignoreInbound only skips listen buffering during echo-prone play
    // when we are NOT in listen mode. Always count + optionally buffer.
    if (this._listening) {
      this._listenBuf.push(Buffer.from(payload));
      this.emit('inbound-frame', payload);
      return;
    }
    if (!this._inboundLogged) {
      this._inboundLogged = true;
      console.log('[rtp] inbound media ok from', rinfo?.address, rinfo?.port, 'bytes', payload.length);
    }
  }

  setIgnoreInbound(ignore) {
    this._ignoreInbound = Boolean(ignore);
  }

  /** When true, do not update remoteIp from inbound (e.g. during STUN). */
  setLatchEnabled(enabled) {
    this._latchEnabled = Boolean(enabled);
  }

  enqueue(mulawBuf) {
    this._queue = Buffer.concat([this._queue, mulawBuf]);
  }

  clearQueue() {
    this._queue = Buffer.alloc(0);
  }

  /** Keep RTP alive with silence while thinking (STT/LLM/TTS). */
  startIdle() {
    if (this._idle || this._playing) return;
    this._idle = true;
    const tick = () => {
      if (!this._idle || this._playing) return;
      this._sendFrame(silenceMulaw(FRAME_MS));
      this._idleTimer = setTimeout(tick, FRAME_MS);
    };
    tick();
  }

  stopIdle() {
    this._idle = false;
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  start() {
    if (this._playing) return;
    this.stopIdle();
    this._playing = true;
    this._ignoreInbound = true;
    this._markerNext = true;
    const tick = () => {
      if (!this._playing) return;
      let frame;
      if (this._queue.length >= FRAME_SAMPLES) {
        frame = this._queue.subarray(0, FRAME_SAMPLES);
        this._queue = this._queue.subarray(FRAME_SAMPLES);
      } else if (this._queue.length > 0) {
        frame = Buffer.concat([this._queue, Buffer.alloc(FRAME_SAMPLES - this._queue.length, 0xff)]);
        this._queue = Buffer.alloc(0);
      } else {
        this.stop();
        this.emit('drained');
        return;
      }
      this._sendFrame(frame);
      this._timer = setTimeout(tick, FRAME_MS);
    };
    tick();
  }

  _sendFrame(payload) {
    if (!this.remoteIp || !this.remotePort) return;
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    // PT=0 PCMU; set marker on first frame after talkspurt / idle→play
    header[1] = this._markerNext ? 0x80 : 0x00;
    this._markerNext = false;
    header.writeUInt16BE(this.seq & 0xffff, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + FRAME_SAMPLES) >>> 0;
    const packet = Buffer.concat([header, payload]);
    try {
      this.socket.send(packet, this.remotePort, this.remoteIp);
    } catch {
      /* ignore */
    }
  }

  stop() {
    this._playing = false;
    this._ignoreInbound = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * Listen until end-of-speech (silence after speech) or maxMs.
   * Keeps sending silence RTP so NAT bindings stay open for inbound media.
   * Returns concatenated μ-law Buffer (may be empty).
   */
  listenUtterance({
    maxMs = 18000,
    silenceMs = 1100,
    minSpeechMs = 450,
    energyThreshold = 80,
    prerollMs = 500,
  } = {}) {
    return new Promise((resolve) => {
      this.stop();
      this._listenBuf = [];
      this._listening = true;
      this._ignoreInbound = false;
      const rxAtStart = this._rxPackets || 0;
      this.startIdle();

      const started = Date.now();
      let speechStartedAt = null;
      let lastSpeechAt = null;
      let settled = false;
      let framesAtSpeechStart = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        this._listening = false;
        clearInterval(check);
        clearInterval(progress);
        const mulaw = Buffer.concat(this._listenBuf);
        this._listenBuf = [];
        console.log(
          '[rtp] listen done frames≈',
          Math.floor(mulaw.length / FRAME_SAMPLES),
          'bytes=',
          mulaw.length,
          'rxDelta=',
          (this._rxPackets || 0) - rxAtStart,
          'rxTotal=',
          this._rxPackets || 0,
          'remote=',
          `${this.remoteIp}:${this.remotePort}`,
        );
        resolve(mulaw);
      };

      const progress = setInterval(() => {
        const delta = (this._rxPackets || 0) - rxAtStart;
        if (delta > 0) {
          console.log('[rtp] listen progress rxDelta=', delta, 'buf=', this._listenBuf.length);
        }
      }, 2000);

      const check = setInterval(() => {
        const now = Date.now();
        if (now - started >= maxMs) {
          finish();
          return;
        }
        if (now - started < prerollMs) return;
        const recent = this._listenBuf.slice(-8);
        const energy = recent.length
          ? recent.reduce((s, f) => s + mulawFrameEnergy(f), 0) / recent.length
          : 0;
        if (energy >= energyThreshold) {
          if (!speechStartedAt) {
            speechStartedAt = now;
            framesAtSpeechStart = this._listenBuf.length;
          }
          lastSpeechAt = now;
        } else if (
          speechStartedAt
          && lastSpeechAt
          && now - speechStartedAt >= minSpeechMs
          && now - lastSpeechAt >= silenceMs
          && this._listenBuf.length > framesAtSpeechStart
        ) {
          finish();
        }
      }, 40);

      setTimeout(finish, maxMs + 200);
    });
  }

  close() {
    this.stop();
    this.stopIdle();
    this._listening = false;
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }
}

/** @deprecated use RtpSession */
class RtpSender extends RtpSession {}

function parseSdpAudio(sdp) {
  const text = String(sdp || '');
  let ip = null;
  let port = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('c=IN IP4 ')) {
      ip = line.slice('c=IN IP4 '.length).trim();
    }
    if (line.startsWith('m=audio ')) {
      const parts = line.split(/\s+/);
      port = Number(parts[1]);
    }
  }
  if (!ip || !port) return null;
  return { ip, port };
}

module.exports = { RtpSession, RtpSender, parseSdpAudio };
