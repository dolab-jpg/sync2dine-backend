/**
 * Keep a small set of UDP port mappings open so Soho media from any source IP
 * can reach us (symmetric/CGNAT otherwise drops post-answer return audio).
 */
function startUpnpRefresh({ sipPort, rtpPortBase, everyMs = 120000 } = {}) {
  let client;
  try {
    client = require('nat-upnp').createClient();
  } catch (e) {
    console.warn('[upnp] nat-upnp not installed — inbound RTP may fail behind NAT:', e.message);
    return () => {};
  }

  // Few ports only — routers drop when flooded with parallel SSDP maps
  const ports = [sipPort, rtpPortBase, rtpPortBase + 2, rtpPortBase + 4];

  const mapPort = (p) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 8000);
      try {
        client.portMapping(
          {
            public: p,
            private: p,
            ttl: 0,
            description: `TradePro-${p}`,
            protocol: 'UDP',
          },
          (err) => {
            clearTimeout(t);
            if (err) console.warn('[upnp] map', p, err.message);
            else console.log('[upnp] mapped', p);
            resolve(err ? err.message : 'ok');
          },
        );
      } catch (e) {
        clearTimeout(t);
        console.warn('[upnp] map', p, e.message);
        resolve(e.message);
      }
    });

  let running = false;
  const mapOnce = async () => {
    if (running) return;
    running = true;
    try {
      for (const p of ports) {
        await mapPort(p);
        await new Promise((r) => setTimeout(r, 400));
      }
    } finally {
      running = false;
    }
  };

  console.log('[upnp] will map UDP', ports.join(','), 'every', everyMs, 'ms');
  void mapOnce();
  const timer = setInterval(() => { void mapOnce(); }, everyMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    try {
      client.close?.();
    } catch {
      /* ignore */
    }
  };
}

module.exports = { startUpnpRefresh };
