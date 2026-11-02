'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createServer } = require('../server');
async function fixture(t, dir) {
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'jbremote-test-'));
  const app = createServer({ dataDir, adminToken: 'test-admin' });
  app.httpServer.listen(0, '127.0.0.1'); await once(app.httpServer, 'listening');
  const port = app.httpServer.address().port, sockets = [];
  t.after(async () => { sockets.forEach(ws => ws.terminate()); await app.close(); if (!dir) fs.rmSync(dataDir, { recursive: true, force: true }); });
  async function client(id, options = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: options.headers || {} });
    sockets.push(ws);
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    ws.sendMessage = message => ws.send(JSON.stringify(message));
    ws.next = async type => {
      const start = Date.now();
      while (Date.now() - start < 3000) { const index = messages.findIndex(m => m.type === type); if (index >= 0) return messages.splice(index, 1)[0]; await new Promise(r => setTimeout(r, 5)); }
      throw new Error(`Missing ${type}: ${JSON.stringify(messages)}`);
    };
    ws.messages = messages;
    await once(ws, 'open');
    if (id) {
      ws.key = options.key || crypto.randomBytes(32).toString('hex');
      ws.sendMessage({ type: 'register', protocol: 2, id, deviceKey: ws.key, pin: '986431', role: options.role || 'host', hostname: 'test', ...options.registration });
      await ws.next(options.error ? 'registration_error' : 'registered');
    }
    return ws;
  }
  return { client, base: `http://127.0.0.1:${port}`, app, dataDir };
}
async function approved(host, viewer, unattended = false) {
  viewer.sendMessage({ type: 'connect_request', targetId: '111111111', mode: unattended ? 'unattended' : 'supervised', pin: '986431', from: '999999999' });
  if (!unattended) { const request = await host.next('incoming_request'); assert.equal(request.from, '222222222'); host.sendMessage({ type: 'connect_accept', requestId: request.requestId }); }
  const approval = await viewer.next('connect_approved'), start = await host.next('session_started');
  assert.equal(start.sessionId, approval.sessionId); return approval.sessionId;
}
test('supervised session requires host consent; routes input and closes both peers', async t => {
  const f = await fixture(t), host = await f.client('111111111'), viewer = await f.client('222222222');
  const sessionId = await approved(host, viewer);
  viewer.sendMessage({ type: 'input', sessionId, targetId: '111111111', action: 'move', x: 500, y: 600 });
  assert.equal((await host.next('input')).from, '222222222');
  viewer.sendMessage({ type: 'disconnect_session', targetId: '111111111', sessionId });
  await host.next('session_closed'); await viewer.next('session_closed');
  viewer.sendMessage({ type: 'chat', targetId: '111111111', sessionId, text: 'after close' });
  assert.equal((await viewer.next('connect_error')).code, 'unauthorized');
});
test('unattended connection needs correct PIN; rejection does not start capture', async t => {
  const f = await fixture(t), host = await f.client('111111111'), viewer = await f.client('222222222');
  viewer.sendMessage({ type: 'connect_request', targetId: '111111111', mode: 'unattended', pin: 'wrong' });
  assert.equal((await viewer.next('connect_error')).code, 'invalid_pin');
  assert.equal(host.messages.length, 0);
  await approved(host, viewer, true);
});
test('unregistered and registered outsiders cannot forge server events or end sessions', async t => {
  const f = await fixture(t), host = await f.client('111111111'), outsider = await f.client();
  for (const type of ['chat', 'session_started', 'disconnect_session', 'signal']) {
    outsider.sendMessage({ type, targetId: '111111111', viewerId: '222222222', text: 'marker' });
    assert.equal((await outsider.next('connect_error')).code, 'registration_required');
  }
  const attacker = await f.client('222222222');
  attacker.sendMessage({ type: 'connect_accept', to: '111111111' });
  assert.equal((await attacker.next('connect_error')).code, 'invalid_request');
  attacker.sendMessage({ type: 'session_started', targetId: '111111111' });
  assert.equal((await attacker.next('connect_error')).code, 'unauthorized');
  assert.equal(host.messages.length, 0);
});
test('session token and direction enforced, including messages reserved to the server', async t => {
  const f = await fixture(t), host = await f.client('111111111'), viewer = await f.client('222222222');
  const sessionId = await approved(host, viewer);
  viewer.sendMessage({ type: 'chat', targetId: '111111111', sessionId: 'wrong', text: 'x' });
  assert.equal((await viewer.next('connect_error')).code, 'unauthorized');
  viewer.sendMessage({ type: 'session_started', targetId: '111111111', sessionId });
  assert.equal((await viewer.next('connect_error')).code, 'invalid_payload');
  host.sendMessage({ type: 'input', targetId: '222222222', sessionId, action: 'text', text: 'x' });
  assert.equal((await host.next('connect_error')).code, 'invalid_payload');
});
test('duplicate identity needs key; reconnect cannot be removed by stale socket', async t => {
  const f = await fixture(t), original = await f.client('111111111');
  await f.client('111111111', { error: true });
  const replacement = await f.client('111111111', { key: original.key });
  await new Promise(r => setTimeout(r, 30));
  const list = await fetch(f.base + '/api/devices', { headers: { Authorization: 'Bearer test-admin' } }).then(r => r.json());
  assert.equal(list.length, 1);
  replacement.sendMessage({ type: 'register', protocol: 2, id: '333333333', deviceKey: replacement.key, role: 'host', pin: '986431' });
  assert.equal((await replacement.next('registration_error')).code, 'identity_conflict');
  const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'identities.json')));
  assert.ok(saved['111111111'].keyHash); assert.ok(!JSON.stringify(saved).includes(replacement.key));
});
test('PIN lock cannot be bypassed using forwarded IP headers', async t => {
  const f = await fixture(t); await f.client('111111111');
  const viewer = await f.client('222222222', { headers: { 'x-forwarded-for': '192.0.2.1' } });
  for (let i = 0; i < 5; i++) { viewer.sendMessage({ type: 'connect_request', targetId: '111111111', mode: 'unattended', pin: '000000' }); await viewer.next('connect_error'); }
  const other = await f.client('333333333', { headers: { 'x-forwarded-for': '192.0.2.2', 'x-real-ip': '192.0.2.2' } });
  other.sendMessage({ type: 'connect_request', targetId: '111111111', mode: 'unattended', pin: '986431' });
  assert.equal((await other.next('connect_error')).code, 'pin_locked');
});
test('HTTP protects inventory and private documents; invalid routes return 404', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/health').then(r => r.json())).protocol, 2);
  assert.equal((await fetch(f.base + '/api/devices')).status, 401);
  for (const url of ['/Informe_Despliegue_JBRemote_AWS.pdf', '/server.js', '/missing', '/data/identities.json']) assert.equal((await fetch(f.base + url)).status, 404);
  assert.equal((await fetch(f.base + '/health', { method: 'POST' })).status, 405);
});
test('malformed message is contained; legacy clients must upgrade', async t => {
  const f = await fixture(t), ws = await f.client();
  ws.send('{'); assert.equal((await ws.next('connect_error')).code, 'invalid_message');
  ws.sendMessage({ type: 'register', id: '111111111', pin: '986431' });
  assert.equal((await ws.next('registration_error')).code, 'upgrade_required');
});
test('file traversal and oversized payloads are rejected; valid small file reaches peer', async t => {
  const f = await fixture(t), host = await f.client('111111111'), viewer = await f.client('222222222');
  const sessionId = await approved(host, viewer);
  const msg = { type: 'file_transfer', targetId: '111111111', sessionId, fileName: '../outside.txt', fileData: 'data:text/plain;base64,b2s=' };
  viewer.sendMessage(msg); assert.equal((await viewer.next('connect_error')).code, 'invalid_payload');
  viewer.sendMessage({ ...msg, fileName: 'ok.txt' }); assert.equal((await host.next('file_transfer')).fileName, 'ok.txt');
});
