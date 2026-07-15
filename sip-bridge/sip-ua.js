/**
 * Soho66 SIP user-agent: REGISTER + outbound INVITE + BYE.
 */
const sip = require('sip');
const digest = require('sip/digest');
const dns = require('dns').promises;
const os = require('os');
const { RtpSession, parseSdpAudio } = require('./rtp');
const { silenceMulaw } = require('./audio');

async function discoverMappedAddress(socket) {
  try {
    const stun = require('stun');
    // Use a throwaway socket bound to the same port is impossible; send STUN on the RTP
    // socket but temporarily ignore latching (caller should not treat STUN as media peer).
    const res = await stun.request('stun.l.google.com:19302', {
      socket,
      maxTimeout: 2500,
    });
    const xor = res.getXorAddress?.() || res.getXorMappedAddress?.();
    if (xor?.address && xor?.port) {
      console.log('[sip] STUN mapped', xor.address, xor.port);
      return { ip: xor.address, port: xor.port };
    }
  } catch (e) {
    console.warn('[sip] STUN failed', e.message);
  }
  return null;
}

function lanIp() {
  const ifs = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifs)) {
    const lower = name.toLowerCase();
    // Skip VirtualBox / Hyper-V / WSL / loopback-ish adapters
    if (/virtualbox|vbox|hyper-v|vethernet|docker|wsl|loopback|vpn|hamachi/.test(lower)) continue;
    for (const iface of ifs[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      // Skip APIPA and common host-only / NAT ranges used by VM soft switches
      if (/^169\.254\./.test(iface.address)) continue;
      if (/^192\.168\.56\./.test(iface.address)) continue;
      if (/^192\.168\.59\./.test(iface.address)) continue;
      if (/^172\.1[6-9]\.|^172\.2[0-9]\.|^172\.3[0-1]\./.test(iface.address) && /vethernet|docker/.test(lower)) continue;
      candidates.push({ name, address: iface.address });
    }
  }
  const preferred = candidates.find((c) => /^192\.168\./.test(c.address) || /^10\./.test(c.address));
  if (preferred) return preferred.address;
  if (candidates[0]) return candidates[0].address;
  for (const name of Object.keys(ifs)) {
    for (const iface of ifs[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

/**
 * SDP c= must be reachable by Soho's media servers.
 * Prefer SIP_BRIDGE_PUBLIC_IP (WAN). "auto" / empty → try ipify, else LAN.
 */
function localIp() {
  const env = process.env.SIP_BRIDGE_PUBLIC_IP?.trim();
  if (env && env.toLowerCase() !== 'auto') {
    return env;
  }
  return lanIp();
}

async function resolvePublicIp() {
  const env = process.env.SIP_BRIDGE_PUBLIC_IP?.trim();
  if (env && env.toLowerCase() !== 'auto') return env;
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      if (j?.ip) {
        console.log('[sip] discovered WAN IP', j.ip, '(set SIP_BRIDGE_PUBLIC_IP to pin)');
        return j.ip;
      }
    }
  } catch (e) {
    console.warn('[sip] WAN IP lookup failed, using LAN', e.message);
  }
  return lanIp();
}

function rstring() {
  return Math.floor(Math.random() * 1e9).toString();
}

function toSipUser(dialRaw) {
  const digits = String(dialRaw).replace(/\D/g, '');
  if (digits.startsWith('44')) return digits;
  if (digits.startsWith('0')) return `44${digits.slice(1)}`;
  return digits;
}

class SipStack {
  constructor() {
    this.started = false;
    this.ip = localIp();
    this.sipPort = Number(process.env.SIP_BRIDGE_SIP_PORT || 50670);
    this.rtpPortBase = Number(process.env.SIP_BRIDGE_RTP_PORT_BASE || 10000);
    this._rtpPortCursor = this.rtpPortBase;
    this.lines = new Map(); // lineId -> line state
    this.activeCalls = new Map();
  }

  async ensurePublicIp() {
    this.ip = await resolvePublicIp();
    return this.ip;
  }

  nextRtpPort() {
    // Single concurrent Aria call — keep a fixed public port so UPnP/port-forward stays valid
    return this.rtpPortBase;
  }

  start() {
    if (this.started) return;
    sip.start(
      {
        port: this.sipPort,
        udp: true,
        tcp: false,
        address: '0.0.0.0',
        publicAddress: this.ip,
      },
      (rq) => {
        if (rq.method === 'BYE') {
          sip.send(sip.makeResponse(rq, 200, 'Ok'));
          return;
        }
        if (rq.method === 'OPTIONS' || rq.method === 'NOTIFY') {
          sip.send(sip.makeResponse(rq, 200, 'Ok'));
          return;
        }
        console.log('[sip] incoming', rq.method, rq.uri);
        sip.send(sip.makeResponse(rq, 200, 'Ok'));
      },
    );
    this.started = true;
    console.log(`[sip] listening udp/${this.sipPort} public=${this.ip} rtpBase=${this.rtpPortBase}`);
  }

  stop() {
    if (!this.started) return;
    try {
      sip.stop();
    } catch {
      /* ignore */
    }
    this.started = false;
  }

  async registerLine(line) {
    this.start();
    const domain = line.sipDomain || process.env.SOHO66_SIP_DOMAIN || 'sbc.soho66.co.uk';
    const regPort = Number(process.env.SOHO66_SIP_PORT || 8060);
    const user = line.sipUsername;
    const pass = line.sipPassword;
    const aor = `sip:${user}@${domain}`;
    const contactUri = `sip:${user}@${this.ip}:${this.sipPort}`;
    const callId = `${rstring()}@${this.ip}`;
    const fromTag = rstring();
    const creds = { user, password: pass };
    let cseq = 1;

    let regHost = domain;
    try {
      const addrs = await dns.resolve4(domain);
      regHost = addrs[0];
    } catch {
      /* use domain */
    }

    const registerUri = `sip:${domain}:${regPort}`;

    const result = await new Promise((resolve) => {
      const sendRegister = (challengeRs, authCtx) => {
        const rq = {
          method: 'REGISTER',
          uri: registerUri,
          headers: {
            to: { uri: aor },
            from: { uri: aor, params: { tag: fromTag } },
            'call-id': callId,
            cseq: { method: 'REGISTER', seq: cseq++ },
            contact: [{ uri: contactUri, params: { expires: 600 } }],
            expires: 600,
            'max-forwards': 70,
            'user-agent': 'TradePro-SipBridge/1.0',
            via: [],
          },
        };
        if (challengeRs) digest.signRequest(authCtx, rq, challengeRs, creds);
        sip.send(rq, (rs) => {
          if ((rs.status === 401 || rs.status === 407) && !challengeRs) {
            sendRegister(rs, {});
            return;
          }
          if (rs.status >= 200 && rs.status < 300) {
            resolve({ ok: true });
            return;
          }
          resolve({ ok: false, message: `REGISTER ${rs.status} ${rs.reason}` });
        });
      };
      sendRegister(null, null);
    });

    if (!result.ok) {
      this.lines.set(line.lineId, {
        ...line,
        status: 'error',
        lastError: result.message,
        regHost,
        aor,
        contactUri,
        creds,
        domain,
        regPort,
      });
      return result;
    }

    this.lines.set(line.lineId, {
      ...line,
      status: 'registered',
      lastError: undefined,
      registeredAt: new Date().toISOString(),
      regHost,
      aor,
      contactUri,
      creds,
      domain,
      regPort,
    });
    return { ok: true, message: `registered ${user}@${domain}` };
  }

  unregisterLine(lineId) {
    const line = this.lines.get(lineId);
    if (!line) return;
    // Best-effort: mark disconnected (expires naturally)
    this.lines.set(lineId, { ...line, status: 'disconnected', registeredAt: undefined });
  }

  listLines() {
    return [...this.lines.values()].map((l) => ({
      lineId: l.lineId,
      status: l.status,
      sipUsername: l.sipUsername,
      sipDomain: l.sipDomain,
      did: l.did,
      lastError: l.lastError,
      registeredAt: l.registeredAt,
    }));
  }

  getLine(lineId) {
    if (lineId && this.lines.has(lineId)) return this.lines.get(lineId);
    return [...this.lines.values()].find((l) => l.status === 'registered');
  }

  /**
   * Place outbound call. onAnswered(rs, helpers) called when 200 OK.
   * helpers: { playMulaw(buf), hangup(), remoteSdp }
   */
  async placeCall({ to, lineId, displayName = 'Aria' }) {
    this.start();
    const line = this.getLine(lineId);
    if (!line || line.status !== 'registered') {
      throw new Error('No registered SIP line — POST /lines/register first');
    }

    const dial = toSipUser(to);
    const target = `sip:${dial}@${line.domain}:${line.regPort}`;
    const inviteCallId = `${rstring()}@${this.ip}`;
    const fromTag = rstring();
    let inviteCseq = 1;

    // Bind RTP on a stable port range so router port-forwards / firewall rules work.
    const rtpPortWanted = this.nextRtpPort();
    let rtp = new RtpSession({ remoteIp: '127.0.0.1', remotePort: 9, localPort: rtpPortWanted });
    let rtpPort;
    try {
      rtpPort = await rtp.bind();
    } catch (e) {
      console.warn('[sip] RTP bind', rtpPortWanted, 'failed, falling back', e.message);
      try { rtp.close(); } catch { /* ignore */ }
      rtp = new RtpSession({ remoteIp: '127.0.0.1', remotePort: 9, localPort: 0 });
      rtpPort = await rtp.bind();
    }

    // Advertise the NAT-mapped public IP:port (not LAN) so Soho sends return RTP correctly.
    rtp.setLatchEnabled(false);
    const mapped = await discoverMappedAddress(rtp.socket);
    rtp.setLatchEnabled(true);
    // Clear any STUN peer latch
    rtp.remoteIp = '127.0.0.1';
    rtp.remotePort = 9;
    const sdpIp = mapped?.ip || this.ip;
    const sdpPort = mapped?.port || rtpPort;
    console.log('[sip] SDP media', sdpIp, sdpPort, '(local', rtpPort, ')');

    const sdp =
      'v=0\r\n' +
      `o=- ${rstring()} ${rstring()} IN IP4 ${sdpIp}\r\n` +
      's=TradePro Aria\r\n' +
      `c=IN IP4 ${sdpIp}\r\n` +
      't=0 0\r\n' +
      `m=audio ${sdpPort} RTP/AVP 0 8 101\r\n` +
      'a=rtpmap:0 PCMU/8000\r\n' +
      'a=rtpmap:8 PCMA/8000\r\n' +
      'a=rtpmap:101 telephone-event/8000\r\n' +
      'a=fmtp:101 0-15\r\n' +
      'a=sendrecv\r\n' +
      'a=rtcp-mux\r\n';

    return new Promise((resolve, reject) => {
      let settled = false;
      let dialog = null;
      let hungUp = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        rtp.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const hangup = () => {
        if (hungUp) return;
        hungUp = true;
        if (!dialog) {
          rtp.close();
          return;
        }
        try {
          sip.send({
            method: 'BYE',
            uri: dialog.remoteUri,
            headers: {
              to: dialog.to,
              from: dialog.from,
              'call-id': dialog.callId,
              cseq: { method: 'BYE', seq: dialog.cseq + 1 },
              via: [],
            },
          });
        } catch {
          /* ignore */
        }
        rtp.close();
        this.activeCalls.delete(inviteCallId);
      };

      const handleInviteRs = async (rs) => {
        if (rs.status >= 100 && rs.status < 200) {
          console.log('[sip] progress', rs.status, rs.reason);
          return;
        }
        if (rs.status < 200 || rs.status >= 300) {
          fail(new Error(`INVITE failed ${rs.status} ${rs.reason}`));
          return;
        }

        // Retransmitted 200 OK — ACK again but do not re-init media
        if (settled && dialog) {
          try {
            sip.send({
              method: 'ACK',
              uri: dialog.remoteUri,
              headers: {
                to: rs.headers.to,
                from: rs.headers.from,
                'call-id': rs.headers['call-id'],
                cseq: { method: 'ACK', seq: rs.headers.cseq.seq },
                via: [],
              },
            });
          } catch {
            /* ignore */
          }
          return;
        }

        const remoteUri =
          (rs.headers.contact && rs.headers.contact[0] && rs.headers.contact[0].uri) || target;
        dialog = {
          remoteUri,
          to: rs.headers.to,
          from: rs.headers.from,
          callId: rs.headers['call-id'],
          cseq: rs.headers.cseq.seq,
        };

        try {
          sip.send({
            method: 'ACK',
            uri: remoteUri,
            headers: {
              to: rs.headers.to,
              from: rs.headers.from,
              'call-id': rs.headers['call-id'],
              cseq: { method: 'ACK', seq: rs.headers.cseq.seq },
              via: [],
            },
          });
        } catch (e) {
          console.warn('[sip] ACK error', e.message);
        }

        const remote = parseSdpAudio(rs.content);
        if (!remote) {
          hangup();
          fail(new Error('No audio SDP in 200 OK'));
          return;
        }

        rtp.remoteIp = remote.ip;
        rtp.remotePort = remote.port;
        rtp.markAnswered();
        rtp.startIdle();
        console.log('[sip] SDP remote media', remote.ip, remote.port, 'localRtp', rtpPort, 'advertised', this.ip);

        const playMulaw = (buf) =>
          new Promise((resPlay) => {
            const audio = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
            if (!audio.length) {
              resPlay();
              return;
            }
            if (rtp._duplex) {
              rtp.enqueue(silenceMulaw(80));
              rtp.enqueue(audio);
              rtp.enqueue(silenceMulaw(240));
              const expectedMs = Math.ceil((audio.length / 8000) * 1000) + 400;
              setTimeout(resPlay, expectedMs);
              console.log('[sip] playMulaw duplex enqueue bytes=', audio.length);
              return;
            }
            rtp.stopIdle();
            rtp.stop();
            rtp.clearQueue();
            rtp.enqueue(silenceMulaw(80));
            rtp.enqueue(audio);
            rtp.enqueue(silenceMulaw(240));
            const expectedMs = Math.ceil((audio.length / 8000) * 1000) + 400;
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              rtp.startIdle();
              resPlay();
            };
            rtp.once('drained', finish);
            // Safety: never leave the caller waiting if drained is missed
            setTimeout(finish, expectedMs + 1500);
            rtp.start();
            console.log('[sip] playMulaw start bytes=', audio.length, 'expectedMs≈', expectedMs, 'to', rtp.remoteIp, rtp.remotePort);
          });

        const listenUtterance = (opts) => rtp.listenUtterance(opts);
        const startIdle = () => rtp.startIdle();
        const stopIdle = () => rtp.stopIdle();
        const startDuplex = () => rtp.startDuplex();
        const stopDuplex = () => rtp.stopDuplex();
        const enqueueMulaw = (buf) => rtp.enqueue(buf);
        const clearOutbound = () => rtp.clearQueue();
        const onInboundFrame = (fn) => {
          rtp.on('inbound-frame', fn);
          return () => rtp.off('inbound-frame', fn);
        };

        this.activeCalls.set(inviteCallId, { hangup, rtp, dialog });

        if (!settled) {
          settled = true;
          resolve({
            providerCallId: inviteCallId,
            remoteSdp: remote,
            playMulaw,
            listenUtterance,
            startIdle,
            stopIdle,
            startDuplex,
            stopDuplex,
            enqueueMulaw,
            clearOutbound,
            onInboundFrame,
            hangup,
            isAlive: () => !hungUp,
          });
        }
      };

      const sendInvite = (challengeRs) => {
        const authCtx = {};
        const rq = {
          method: 'INVITE',
          uri: target,
          headers: {
            to: { uri: `sip:${dial}@${line.domain}` },
            from: {
              name: displayName,
              uri: line.aor,
              params: { tag: fromTag },
            },
            'call-id': inviteCallId,
            cseq: { method: 'INVITE', seq: inviteCseq++ },
            contact: [{ uri: line.contactUri }],
            'content-type': 'application/sdp',
            'max-forwards': 70,
            'user-agent': 'TradePro-SipBridge/1.0',
            via: [],
            allow: 'INVITE, ACK, CANCEL, BYE, OPTIONS',
          },
          content: sdp,
        };
        if (challengeRs) digest.signRequest(authCtx, rq, challengeRs, line.creds);
        console.log('[sip] INVITE', target);
        sip.send(rq, (rs) => {
          if ((rs.status === 401 || rs.status === 407) && !challengeRs) {
            sendInvite(rs);
            return;
          }
          handleInviteRs(rs).catch(fail);
        });
      };

      setTimeout(() => fail(new Error('INVITE timeout')), 60000);
      sendInvite(null);
    });
  }
}

module.exports = { SipStack, toSipUser, localIp };
