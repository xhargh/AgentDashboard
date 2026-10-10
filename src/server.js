import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const assets = new Map(await Promise.all(['index.html', 'app.js', 'session-state.js', 'style.css'].map(async name =>
  ['/' + (name === 'index.html' ? '' : name), { body: await readFile(new URL('../public/' + name, import.meta.url)),
    type: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }])));
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function validReport(v) {
  return v && typeof v.instanceId === 'string' && v.instanceId.length <= 100 &&
    (v.machineId === undefined || typeof v.machineId === 'string' && v.machineId.length <= 100) &&
    typeof v.host === 'string' && v.host.length <= 200 && (v.directory === undefined || typeof v.directory === 'string') &&
    Array.isArray(v.sessions) && v.sessions.length <= 1000 && v.sessions.every(s => s && typeof s.id === 'string' &&
      typeof s.status === 'string' && (s.title === undefined || typeof s.title === 'string') &&
      (s.directory === undefined || typeof s.directory === 'string') &&
      (s.activity === undefined || typeof s.activity === 'string') && (s.agent === undefined || typeof s.agent === 'string') &&
      (s.todos === undefined || Array.isArray(s.todos))) &&
    (v.git === undefined || v.git && typeof v.git === 'object' && !Array.isArray(v.git));
}
export function createServer({ token, now = Date.now } = {}) {
  if (token && token.length < 24) throw new Error('SUPERVISOR_TOKEN must contain at least 24 characters');
  const instances = new Map();
  let revision = 0;
  const prune = () => { for (const [key, v] of instances) if (now() - v.lastSeen > 86400000) { instances.delete(key); revision++; } };
  return http.createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; }
    catch { return reply(400, { error: 'Invalid request URL' }); }
    if (!token) {
      // Check both the peer and Host: loopback binding alone does not stop DNS rebinding.
      const peer = req.socket?.remoteAddress;
      const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
      const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(req.headers.host || '');
      if (!localPeer || !localHost) return reply(403, { error: 'Local mode only accepts loopback connections and localhost addresses' });
    }
    if (path.startsWith('/api/')) {
      if (token && !equal(req.headers.authorization, `Bearer ${token}`)) return reply(401, { error: 'Invalid access token' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return reply(403, { error: 'Cross-origin request rejected' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return reply(403, { error: 'Cross-site request rejected' });
      prune();
      if (path === '/api/state' && req.method === 'GET') {
        const time = now();
        for (const instance of instances.values()) {
          const online = time - instance.lastSeen < 20000;
          if (online !== instance.online) { instance.online = online; revision++; }
        }
        const etag = `"${revision}"`;
        res.setHeader('etag', etag);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { 'cache-control': 'no-store' }); return res.end(); }
        return reply(200, { revision, instances: [...instances.values()].map(v => ({ ...v })), serverTime: time, mode: token ? 'network' : 'local' });
      }
      if (path === '/api/report' && req.method === 'POST') {
        try {
          let size = 0, chunks = [];
          for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { reply(413, { error: 'Report exceeds 1 MiB' }); return; } chunks.push(chunk); }
          const v = JSON.parse(Buffer.concat(chunks).toString());
          if (!validReport(v)) return reply(400, { error: 'Invalid report' });
          if (!instances.has(v.instanceId) && instances.size >= 2000) return reply(503, { error: 'Instance limit reached' });
          const previous = instances.get(v.instanceId);
          const online = previous ? now() - previous.lastSeen < 20000 : false;
          const meaningfulChange = !previous || JSON.stringify({ ...previous, lastSeen: undefined, online: undefined }) !== JSON.stringify(v);
          instances.set(v.instanceId, { ...v, lastSeen: now(), online: true });
          if (meaningfulChange || !online) revision++;
          return reply(200, { ok: true });
        } catch { return reply(400, { error: 'Invalid JSON report' }); }
      }
      return reply(404, { error: 'Unknown endpoint' });
    }
    const asset = assets.get(path);
    if (req.method === 'GET' && asset) { res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' }); res.end(asset.body); }
    else reply(404, { error: 'Not found' });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const token = process.env.SUPERVISOR_TOKEN;
    const host = token ? (process.env.HOST || '0.0.0.0') : '127.0.0.1';
    const server = createServer({ token });
    server.requestTimeout = 10000;
    server.on('error', error => { console.error(`Companion failed: ${error.message}`); process.exitCode = 1; });
    server.listen(Number(process.env.PORT || 4317), host, () => console.log(`Supervisor ${token ? 'network (token required)' : 'local (no token)'} mode listening on ${host}:${process.env.PORT || 4317}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
