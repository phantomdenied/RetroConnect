'use strict';
// Connection check helpers: how fast is the link to your buddy, and can each
// of you reach the other's netplay port (what RetroArch needs to connect)?

const net = require('net');

/** Can we open a TCP connection to host:port? */
function tcpReachable(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok, error) => { sock.destroy(); resolve(ok ? { reachable: true } : { reachable: false, error }); };
    sock.setTimeout(timeoutMs, () => done(false, 'timed out (likely a firewall or the port isn\'t forwarded)'));
    sock.once('connect', () => done(true));
    sock.once('error', (err) => done(false, err.code === 'ECONNREFUSED' ? 'connection refused (nothing listening)' : err.code || err.message));
  });
}

/**
 * Listen on `port` for a while so the other side can test it. Resolves to
 * { listening, close } or { listening: false, error }.
 */
function openTestListener(port, ttlMs = 10000) {
  return new Promise((resolve) => {
    let timer = null;
    let closed = false;
    const close = () => { if (closed) return; closed = true; clearTimeout(timer); server.close(); };
    // One test connection is all we need: close right away so the port is
    // free again for RetroArch if someone starts hosting.
    const server = net.createServer((sock) => { sock.end(); close(); });
    server.once('error', (err) => resolve({
      listening: false,
      code: err.code,
      error: err.code === 'EADDRINUSE' ? `port ${port} is already in use by another program` : err.message,
    }));
    server.listen(port, '0.0.0.0', () => {
      timer = setTimeout(close, ttlMs);
      resolve({ listening: true, close });
    });
  });
}

/** Round-trip times (ms) of n small requests to the buddy's app. */
async function measurePing(client, n = 5) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await client.getJson('/api/status');
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    median: Math.round(median),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    jitter: Math.round(sorted[sorted.length - 1] - sorted[0]),
    quality: median < 40 ? 'great' : median < 80 ? 'good' : median < 150 ? 'ok' : 'poor',
  };
}

module.exports = { tcpReachable, openTestListener, measurePing };
