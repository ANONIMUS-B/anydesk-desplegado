'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { WebSocketServer, WebSocket } = require('ws');
const VERSION = '1.1.0', PROTOCOL = 2, MAX_FILE_BYTES = 4 * 1024 * 1024;
const norm = value => typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const text = (value, max) => typeof value === 'string' && value.length <= max;

function createServer(options = {}) {
  const devices = new Map(), sessions = new Map(), pending = new Map(), attempts = new Map(), limits = new Map();
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const publicDir = options.publicDir || path.join(__dirname, 'public');
  const registryPath = path.join(dataDir, 'identities.json');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const registry = new Map(fs.existsSync(registryPath) ? Object.entries(JSON.parse(fs.readFileSync(registryPath, 'utf8'))) : []);
  const owners = new Map([...registry].map(([id, entry]) => [entry.keyHash, id]));
  const proxies = (options.trustedProxies || process.env.TRUSTED_PROXIES || '').split(',').filter(Boolean);
  const adminToken = options.adminToken || process.env.ADMIN_TOKEN;
  let stopping = false;
  function persist() {
    fs.writeFileSync(`${registryPath}.tmp`, JSON.stringify(Object.fromEntries(registry)), { mode: 0o600 });
    fs.renameSync(`${registryPath}.tmp`, registryPath);
  }
  function clientIp(req) {
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown';
    const header = req.headers['x-real-ip'];
    return proxies.includes(remote) && typeof header === 'string' && net.isIP(header) ? header : remote;
  }
  function rate(key, max, period) {
    const now = Date.now();
    let item = limits.get(key);
    if (!item || item.until <= now) { item = { count: 0, until: now + period }; limits.set(key, item); }
    return ++item.count <= max;
  }
  function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 8 * 1024 * 1024) return ws.close(1013, 'Slow receiver');
    ws.send(JSON.stringify(message));
  }
  const fail = (ws, reason, code = 'invalid_request', type = 'connect_error') => send(ws, { type, reason, code });
  function endSession(session, reason) {
    if (!session || !sessions.delete(session.id)) return;
    for (const d of [session.host, session.viewer]) {
      if (d.session === session.id) d.session = null;
      send(d.ws, { type: 'session_closed', sessionId: session.id, reason });
    }
  }
  function startSession(host, viewer, mode) {
    if (host.session || viewer.session) return fail(viewer.ws, 'Uno de los equipos está ocupado.', 'busy');
    for (const [id, r] of pending) if ([host, viewer].includes(r.host) || [host, viewer].includes(r.viewer)) {
      pending.delete(id);
      send(r.host.ws, { type: 'request_expired', requestId: id });
      if (r.viewer !== viewer) fail(r.viewer.ws, 'El equipo está ocupado.', 'busy');
    }
    const session = { id: crypto.randomUUID(), host, viewer, mode };
    host.session = viewer.session = session.id;
    sessions.set(session.id, session);
    send(viewer.ws, { type: 'connect_approved', targetId: host.id, sessionId: session.id, mode });
    send(host.ws, { type: 'session_started', viewerId: viewer.id, sessionId: session.id, mode });
  }
  function cleanup(d) {
    if (!d) return;
    endSession(sessions.get(d.session), 'El equipo remoto se desconectó.');
    for (const [id, r] of pending) if (r.host === d || r.viewer === d) {
      pending.delete(id);
      fail(r.viewer.ws, 'La solicitud terminó por desconexión.', 'disconnected');
      send(r.host.ws, { type: 'request_expired', requestId: id });
    }
    if (devices.get(d.id) === d) devices.delete(d.id);
  }
  const httpServer = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body)); };
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return json(405, { error: 'method_not_allowed' }); }
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return json(400, { error: 'bad_request' }); }
    if (pathname === '/health' || pathname === '/api/status') return json(stopping ? 503 : 200, { status: stopping ? 'stopping' : 'online', service: 'JBRemote', version: VERSION, protocol: PROTOCOL, uptime: Math.floor(process.uptime()) });
    if (pathname === '/api/devices') {
      if (!adminToken || !equal(req.headers.authorization, `Bearer ${adminToken}`)) return json(401, { error: 'unauthorized' });
      return json(200, [...devices.values()].map(d => ({ id: d.id, hostname: d.hostname, status: d.session ? 'busy' : 'online' })));
    }
    const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/styles.css': ['styles.css', 'text/css'], '/JBRemote.exe': ['JBRemote.exe', 'application/octet-stream'], '/JBRemote.apk': ['JBRemote.apk', 'application/vnd.android.package-archive'], '/release.json': ['release.json', 'application/json'] };
    if (!Object.hasOwn(files, pathname)) return json(404, { error: 'not_found' });
    const [name, mime] = files[pathname];
    fs.stat(path.join(publicDir, name), (err, stat) => {
      if (err || !stat.isFile()) return json(404, { error: 'not_found' });
      const headers = { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' };
      if (/\.(exe|apk)$/.test(name)) headers['Content-Disposition'] = `attachment; filename="${name}"`;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(path.join(publicDir, name));
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 6 * 1024 * 1024, perMessageDeflate: false });
  httpServer.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const allowed = !origin || ['null', 'file://', 'https://localhost', 'http://localhost', 'capacitor://localhost'].includes(origin);
    if (stopping || req.url !== '/' || !allowed || wss.clients.size >= 500 || !rate(`upgrade:${clientIp(req)}`, 60, 60000)) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    const ip = clientIp(req), socketId = crypto.randomUUID();
    let device = null, alive = true;
    const deadline = setTimeout(() => { if (!device) ws.close(1008, 'Registration required'); }, 10000);
    deadline.unref();
    ws.on('pong', () => { alive = true; });
    ws.checkAlive = () => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } };
    ws.on('message', (raw, binary) => {
      try {
        if (binary || !rate(`socket:${socketId}`, 600, 1000)) return ws.close(1008, 'Rate limit');
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !text(msg.type, 40)) return fail(ws, 'Mensaje inválido.');
        if (msg.type === 'register') {
          if (!rate(`register:${ip}`, 60, 60000)) return fail(ws, 'Demasiados registros.', 'rate_limit', 'registration_error');
          const id = norm(msg.id);
          if (msg.protocol !== PROTOCOL) return fail(ws, 'Actualiza JBRemote a la versión 1.1.0 o posterior.', 'upgrade_required', 'registration_error');
          if (!/^\d{9}$/.test(id) || !/^[a-f0-9]{64}$/.test(msg.deviceKey || '') || !['host', 'viewer'].includes(msg.role)) return fail(ws, 'Identidad inválida.', 'identity_invalid', 'registration_error');
          if (msg.role === 'host' && !/^\d{6,12}$/.test(msg.pin || '')) return fail(ws, 'PIN inválido.', 'pin_invalid', 'registration_error');
          const keyHash = hash(msg.deviceKey);
          if ((device && (device.id !== id || device.keyHash !== keyHash || device.role !== msg.role)) || (registry.has(id) && !equal(registry.get(id).keyHash, keyHash)) || (owners.has(keyHash) && owners.get(keyHash) !== id)) return fail(ws, 'Esta identidad pertenece a otro dispositivo.', 'identity_conflict', 'registration_error');
          if (!registry.has(id)) {
            if (registry.size >= 10000 || !rate(`new:${ip}`, 20, 3600000)) return fail(ws, 'Límite de registros alcanzado.', 'rate_limit', 'registration_error');
            registry.set(id, { keyHash, createdAt: new Date().toISOString() });
            try { persist(); } catch (err) { registry.delete(id); throw err; }
            owners.set(keyHash, id);
          }
          const previous = devices.get(id);
          if (previous && previous.ws !== ws) { cleanup(previous); previous.ws.close(4001, 'Reconnected'); }
          const salt = crypto.randomBytes(16).toString('hex');
          device = device || { id, ws, keyHash, session: null };
          Object.assign(device, { role: msg.role, hostname: text(msg.hostname, 100) ? msg.hostname : 'Dispositivo', salt, pinHash: msg.role === 'host' ? hash(salt + msg.pin) : null });
          devices.set(id, device); clearTimeout(deadline);
          return send(ws, { type: 'registered', id, status: 'ok', protocol: PROTOCOL, maxFileBytes: MAX_FILE_BYTES });
        }
        if (!device || devices.get(device.id) !== device) return fail(ws, 'Registro requerido.', 'registration_required');
        if (msg.type === 'connect_request') {
          if (!rate(`request:${ip}`, 12, 60000)) return fail(ws, 'Espera antes de volver a intentar.', 'rate_limit');
          const host = devices.get(norm(msg.targetId));
          if (!host || host.role !== 'host' || host === device) return fail(ws, 'Equipo no disponible.', 'unavailable');
          if (host.session || device.session) return fail(ws, 'Equipo ocupado.', 'busy');
          if (!['supervised', 'unattended'].includes(msg.mode)) return fail(ws, 'Modo inválido.');
          if (msg.mode === 'unattended') {
            const now = Date.now(), keys = [`host:${host.id}`, `pin:${ip}:${host.id}`];
            for (const key of keys) { const a = attempts.get(key); if (a && a.until > now && a.count >= 5) return fail(ws, 'Demasiados intentos. Espera tres minutos.', 'pin_locked'); }
            if (!text(msg.pin, 12) || !equal(hash(host.salt + msg.pin), host.pinHash)) {
              for (const key of keys) { const a = attempts.get(key); attempts.set(key, { count: a && a.until > now ? a.count + 1 : 1, until: now + 180000 }); }
              return fail(ws, 'PIN incorrecto.', 'invalid_pin');
            }
            keys.forEach(key => attempts.delete(key)); return startSession(host, device, 'unattended');
          }
          if ([...pending.values()].some(r => r.host === host || r.viewer === device)) return fail(ws, 'Ya existe una solicitud pendiente.', 'pending');
          const requestId = crypto.randomUUID();
          pending.set(requestId, { host, viewer: device, until: Date.now() + 60000 });
          return send(host.ws, { type: 'incoming_request', requestId, from: device.id, requesterName: device.hostname });
        }
        if (msg.type === 'connect_accept' || msg.type === 'connect_reject') {
          const r = pending.get(msg.requestId);
          if (!r || r.host !== device || r.until < Date.now() || devices.get(r.viewer.id) !== r.viewer) return fail(ws, 'Solicitud vencida o inválida.', 'invalid_request');
          pending.delete(msg.requestId);
          if (msg.type === 'connect_reject') return send(r.viewer.ws, { type: 'connect_rejected', reason: 'El anfitrión rechazó la conexión.' });
          return startSession(device, r.viewer, 'supervised');
        }
        const session = sessions.get(device.session);
        const peer = session && (session.host === device ? session.viewer : session.host);
        if (!session || msg.sessionId !== session.id || !peer || norm(msg.targetId) !== peer.id) return fail(ws, 'Sesión no autorizada.', 'unauthorized');
        if (msg.type === 'disconnect_session' || msg.type === 'session_closed') return endSession(session, 'El usuario finalizó la sesión.');
        let payload;
        const viewer = session.viewer === device;
        switch (msg.type) {
          case 'chat': if (text(msg.text, 4000)) payload = { text: msg.text }; break;
          case 'clipboard_sync': if (text(msg.text, 65536)) payload = { text: msg.text }; break;
          case 'signal': if (msg.data && typeof msg.data === 'object' && JSON.stringify(msg.data).length < 65536) payload = { data: msg.data }; break;
          case 'screen_frame': if (!viewer && text(msg.frame, 2 * 1024 * 1024) && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(msg.frame)) { if (peer.ws.bufferedAmount > 32768) return; payload = { frame: msg.frame }; } break;
          case 'screens_info': if (!viewer && Number.isInteger(msg.screensCount) && msg.screensCount > 0 && msg.screensCount <= 16) payload = { screensCount: msg.screensCount }; break;
          case 'get_screens_request': if (viewer) payload = {}; break;
          case 'switch_monitor': if (viewer && Number.isInteger(msg.monitorIndex) && msg.monitorIndex >= 0 && msg.monitorIndex < 16) payload = { monitorIndex: msg.monitorIndex }; break;
          case 'quality_change': if (viewer && ['fast', 'balanced', 'ultra'].includes(msg.quality)) payload = { quality: msg.quality }; break;
          case 'file_transfer': {
            if (!text(msg.fileName, 180) || /[\\/:*?"<>|\x00-\x1f]/.test(msg.fileName) || !text(msg.fileData, Math.ceil(MAX_FILE_BYTES / 3) * 4 + 256)) break;
            const match = /^data:[^,\r\n]{0,180};base64,([A-Za-z0-9+/]*={0,2})$/.exec(msg.fileData);
            if (match && Buffer.byteLength(match[1], 'base64') <= MAX_FILE_BYTES && rate(`file:${device.id}`, 6, 60000)) payload = { fileName: msg.fileName, fileData: msg.fileData };
            break;
          }
          case 'input': {
            if (!viewer || !['move', 'mousedown', 'mouseup', 'click', 'dblclick', 'scroll', 'key', 'hotkey', 'text'].includes(msg.action)) break;
            payload = { action: msg.action };
            if (['move', 'mousedown', 'mouseup', 'click', 'dblclick'].includes(msg.action)) {
              if (![msg.x, msg.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1000)) { payload = null; break; }
              payload.x = msg.x; payload.y = msg.y; payload.button = ['LEFT', 'RIGHT', 'MIDDLE'].includes(msg.button) ? msg.button : 'LEFT';
            } else if (msg.action === 'scroll') { if (!Number.isFinite(msg.delta) || Math.abs(msg.delta) > 1200) { payload = null; break; } payload.delta = msg.delta; }
            else if (msg.action === 'text') { if (!text(msg.text, 2000) || /[\r\n\x00]/.test(msg.text)) { payload = null; break; } payload.text = msg.text; }
            else { if (!/^[a-z0-9]{1,12}$/i.test(msg.key || '') || (msg.action === 'hotkey' && !['CTRL', 'ALT', 'SHIFT', 'WIN'].includes(msg.mod))) { payload = null; break; } payload.key = msg.key; if (msg.mod) payload.mod = msg.mod; }
            break;
          }
        }
        if (!payload) return fail(ws, 'Mensaje no permitido o demasiado grande.', 'invalid_payload');
        send(peer.ws, { ...payload, type: msg.type, from: device.id, sessionId: session.id });
      } catch (error) {
        fail(ws, 'No se pudo procesar el mensaje.', 'invalid_message');
        if (!(error instanceof SyntaxError)) console.error('[JBRemote]', error.code || error.name);
      }
    });
    ws.on('close', () => { clearTimeout(deadline); limits.delete(`socket:${socketId}`); cleanup(device); });
    ws.on('error', () => {});
  });
  const interval = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) ws.checkAlive();
    for (const [key, item] of limits) if (item.until <= now) limits.delete(key);
    for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
    for (const [id, r] of pending) if (r.until <= now) { pending.delete(id); fail(r.viewer.ws, 'La solicitud expiró.', 'expired'); send(r.host.ws, { type: 'request_expired', requestId: id }); }
  }, 30000);
  interval.unref();
  function close() {
    if (stopping) return Promise.resolve();
    stopping = true; clearInterval(interval);
    for (const s of sessions.values()) endSession(s, 'Servidor en mantenimiento. Reconecta en unos segundos.');
    for (const ws of wss.clients) ws.close(1001, 'Server restarting');
    const timeout = setTimeout(() => { for (const ws of wss.clients) ws.terminate(); httpServer.closeAllConnections(); }, 2000);
    timeout.unref();
    return new Promise(resolve => httpServer.close(() => { clearTimeout(timeout); wss.close(); resolve(); }));
  }
  return { httpServer, close };
}
if (require.main === module) {
  const app = createServer();
  app.httpServer.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log(`[JBRemote ${VERSION}] ready`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
module.exports = { createServer, MAX_FILE_BYTES, PROTOCOL };
