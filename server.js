/**
 * ============================================================================
 * JBRemote Enterprise Signaling & Relay Engine
 * Optimizado para cPanel (CloudLinux / Phusion Passenger / Apache Reverse Proxy)
 * y despliegues en la nube (Render / VPS)
 * ============================================================================
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

// Puerto dinámico asignado por cPanel / CloudLinux Passenger o variable de entorno
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Almacén en memoria indexado por normId (O(1))
const devices = new Map();
const sessions = new Map();
const pinAttempts = new Map(); // attemptKey -> { count, lockedUntil }

function normId(id) {
  return String(id || '').replace(/[\s\-_]/g, '').trim();
}

function findDevice(id) {
  if (!id) return null;
  return devices.get(normId(id)) || null;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
}

// 1. Servidor HTTP (API REST, Health Check y Archivos Estáticos)
const httpServer = http.createServer((req, res) => {
  // Encabezados CORS universales
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Endpoint: Lista de dispositivos conectados
  if (pathname === '/api/devices') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const list = Array.from(devices.values()).map(d => ({
      id: d.id,
      hostname: d.hostname,
      ip: d.ip,
      status: d.status
    }));
    return res.end(JSON.stringify(list));
  }

  // Endpoint: Health Check y Estado del Sistema
  if (pathname === '/api/status' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'online',
      service: 'JBRemote Enterprise Cloud Engine (cPanel)',
      version: '1.0.0',
      uptime: Math.floor(process.uptime()),
      devices_online: devices.size,
      active_sessions: sessions.size,
      timestamp: new Date().toISOString()
    }));
  }

  // Comprobar si existe archivo estático en carpeta public/
  const publicDir = path.join(__dirname, 'public');
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') safePath = 'index.html';
  const filePath = path.join(publicDir, safePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.exe': 'application/octet-stream',
      '.apk': 'application/vnd.android.package-archive',
      '.zip': 'application/zip'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };

    if (ext === '.exe' || ext === '.apk') {
      headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
    }

    res.writeHead(200, headers);
    return fs.createReadStream(filePath).pipe(res);
  }

  // Respuesta raíz por defecto si no hay archivo estático
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    service: 'JBRemote Cloud Engine',
    portal: 'https://jbtechline.net.pe',
    devices_online: devices.size,
    active_sessions: sessions.size,
    message: 'JBRemote WebSocket Signaling Server is operating normally.'
  }));
});

// 2. Servidor WebSocket montado sobre el mismo servidor HTTP (Puerto único para cPanel)
const wss = new WebSocketServer({ server: httpServer });

// Keep-alive Heartbeat cada 30 segundos (evita caídas por proxy timeout en Apache/cPanel)
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[Heartbeat] Desconectando cliente inactivo');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let devId = null;
  const clientIp = getClientIp(req);

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData);

      // 1. Registro de Dispositivo
      if (msg.type === 'register') {
        devId = msg.id;
        const normalized = normId(devId);
        devices.set(normalized, {
          id: msg.id,
          normId: normalized,
          ws,
          ip: clientIp,
          hostname: msg.hostname || 'Windows PC',
          pin: String(msg.pin || '592814').trim(),
          status: 'online',
          lastSeen: Date.now()
        });
        ws.send(JSON.stringify({ type: 'registered', id: devId, status: 'ok' }));
        console.log(`[Registro] Dispositivo conectado: ${devId} (${msg.hostname || 'PC'}) desde IP: ${clientIp}`);
      }

      // 2. Solicitud de Conexión
      else if (msg.type === 'connect_request') {
        const target = findDevice(msg.targetId);
        if (!target) {
          return ws.send(JSON.stringify({ type: 'connect_error', reason: 'Destino no disponible en la red' }));
        }

        if (msg.mode === 'unattended') {
          const attemptKey = `${clientIp}_${normId(target.id)}`;
          const attemptInfo = pinAttempts.get(attemptKey);
          const now = Date.now();

          if (attemptInfo && attemptInfo.lockedUntil && now < attemptInfo.lockedUntil) {
            const remaining = Math.ceil((attemptInfo.lockedUntil - now) / 1000);
            return ws.send(JSON.stringify({
              type: 'connect_error',
              reason: `Demasiados intentos fallidos. Bloqueado temporalmente por ${remaining}s.`
            }));
          }

          if (String(msg.pin || '').trim() === target.pin) {
            pinAttempts.delete(attemptKey);
            sessions.set(normId(msg.from) + '->' + normId(target.id), 1);
            ws.send(JSON.stringify({ type: 'connect_approved', mode: 'unattended', targetId: target.id }));
            target.ws.send(JSON.stringify({ type: 'session_started', viewerId: msg.from, mode: 'unattended' }));
            console.log(`[Sesión] Acceso Desatendido aprobado: ${msg.from} -> ${target.id}`);
          } else {
            const currentFails = (attemptInfo ? attemptInfo.count : 0) + 1;
            if (currentFails >= 5) {
              pinAttempts.set(attemptKey, { count: currentFails, lockedUntil: now + 3 * 60 * 1000 });
              console.warn(`[Seguridad] Bloqueada IP ${clientIp} por 5 intentos fallidos hacia ${target.id}`);
              return ws.send(JSON.stringify({
                type: 'connect_error',
                reason: 'PIN incorrecto. Cuenta bloqueada temporalmente por 3 minutos.'
              }));
            } else {
              pinAttempts.set(attemptKey, { count: currentFails, lockedUntil: null });
              return ws.send(JSON.stringify({
                type: 'connect_error',
                reason: `Contraseña PIN incorrecta (${currentFails}/5 intentos)`
              }));
            }
          }
        } else {
          // Modo Supervisado: Solicitar autorización al anfitrión
          target.ws.send(JSON.stringify({
            type: 'incoming_request',
            from: msg.from,
            requesterName: msg.requesterName || 'Técnico Remoto'
          }));
          console.log(`[Sesión] Solicitud de Acceso Supervisado enviada: ${msg.from} -> ${target.id}`);
        }
      }

      // 3. Aprobación de Conexión Supervisada
      else if (msg.type === 'connect_accept') {
        const viewer = findDevice(msg.to);
        if (viewer) {
          sessions.set(normId(viewer.id) + '->' + normId(devId), 1);
          viewer.ws.send(JSON.stringify({ type: 'connect_approved', mode: 'supervised', targetId: devId }));
          console.log(`[Sesión] Acceso Supervisado aceptado por host: ${devId} -> ${viewer.id}`);
        }
      }

      // 4. Rechazo de Conexión
      else if (msg.type === 'connect_reject') {
        const viewer = findDevice(msg.to);
        if (viewer) {
          viewer.ws.send(JSON.stringify({ type: 'connect_rejected', reason: 'El usuario rechazó la conexión' }));
        }
      }

      // 5. Cierre de Sesión
      else if (msg.type === 'disconnect_session' || msg.type === 'session_closed') {
        const peer = findDevice(msg.targetId);
        if (peer && peer.ws.readyState === 1) {
          peer.ws.send(JSON.stringify({
            type: 'session_closed',
            from: devId,
            reason: msg.reason || 'El usuario remoto finalizó la sesión.'
          }));
        }
        sessions.delete(normId(devId) + '->' + normId(msg.targetId));
        sessions.delete(normId(msg.targetId) + '->' + normId(devId));
        console.log(`[Sesión] Finalizada entre ${devId} y ${msg.targetId}`);
      }

      // 6. Retransmisión de Datos en Tiempo Real (Pantalla, WebRTC, Input, Chat)
      else if (msg.targetId) {
        const sourceNormalized = normId(devId);
        const targetNormalized = normId(msg.targetId);
        const sessionKey1 = `${sourceNormalized}->${targetNormalized}`;
        const sessionKey2 = `${targetNormalized}->${sourceNormalized}`;
        const isSessionAllowed = sessions.has(sessionKey1) || sessions.has(sessionKey2);

        // Control de Seguridad: Input, archivos y portapapeles requieren sesión autorizada previa
        const sensitiveTypes = ['input', 'file_transfer', 'clipboard_sync', 'switch_monitor'];
        if (sensitiveTypes.includes(msg.type) && !isSessionAllowed) {
          console.warn(`[Seguridad] Bloqueado mensaje no autorizado tipo '${msg.type}' desde ${devId} hacia ${msg.targetId}`);
          return;
        }

        const peer = findDevice(msg.targetId);
        if (peer && peer.ws.readyState === 1) {
          // Si el receptor tiene más de 32 KB en cola de red, descartar frame obsoleto para evitar cámara lenta
          if (msg.type === 'screen_frame' && peer.ws.bufferedAmount > 32 * 1024) {
            return;
          }
          peer.ws.send(JSON.stringify({ ...msg, from: devId }));
        }
      }
    } catch (err) {
      console.error('[Error mensaje]', err.message);
    }
  });

  ws.on('close', () => {
    if (devId) {
      const normalizedDevId = normId(devId);
      devices.delete(normalizedDevId);
      console.log(`[Desconexión] Dispositivo desconectado: ${devId}`);

      for (const [sessionKey] of sessions.entries()) {
        const [p1, p2] = sessionKey.split('->');
        if (p1 === normalizedDevId || p2 === normalizedDevId) {
          const otherId = p1 === normalizedDevId ? p2 : p1;
          const otherPeer = findDevice(otherId);
          if (otherPeer && otherPeer.ws.readyState === 1) {
            otherPeer.ws.send(JSON.stringify({
              type: 'session_closed',
              from: devId,
              reason: 'El equipo remoto se desconectó de la red.'
            }));
          }
          sessions.delete(sessionKey);
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[Error socket ${devId || 'desconocido'}]:`, err.message);
  });
});

// Iniciar servidor HTTP/WebSocket
httpServer.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`[JBRemote Engine] Servidor activo en puerto ${PORT}`);
  console.log(`[JBRemote Engine] Protocolos HTTP y WebSocket unificados`);
  console.log(`====================================================`);
});

// Cierre elegante
process.on('SIGTERM', () => {
  console.log('[JBRemote] Recibida señal SIGTERM, cerrando servidor...');
  httpServer.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[JBRemote] Recibida señal SIGINT, cerrando servidor...');
  httpServer.close(() => process.exit(0));
});
