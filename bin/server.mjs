#!/usr/bin/env node
// Local dashboard server: http://127.0.0.1:7788  (binds to localhost only)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../lib/core.mjs';
import { getLang, bundle } from '../lib/i18n.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web');
const IDLE_EXIT_MS = 12 * 60 * 60 * 1000; // exit after 12h with no activity and no viewers
const clients = new Set();
let lastActivity = Date.now();

function projects() {
  const reg = core.readRegistry();
  return Object.values(reg.projects || {})
    .filter(p => fs.existsSync(path.join(core.progressDir(p.root), 'project.json')))
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

function findProject(id) {
  return projects().find(p => p.id === id);
}

// change detection: newest mtime under each project's .progress (+ fallback)
function stamp(root) {
  let max = 0;
  const scan = dir => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name.endsWith('.json')) { try { max = Math.max(max, fs.statSync(p).mtimeMs); } catch { /* ignore */ } }
    }
  };
  scan(core.progressDir(root));
  scan(path.join(core.FALLBACK_DIR, core.hash(path.join(core.progressDir(root), 'sessions'))));
  return max;
}

const stamps = new Map();
setInterval(() => {
  for (const p of projects()) {
    const s = stamp(p.root);
    if (stamps.has(p.id) && stamps.get(p.id) !== s) {
      lastActivity = Date.now();
      broadcast('update', { id: p.id });
    }
    stamps.set(p.id, s);
  }
  if (!clients.size && Date.now() - lastActivity > IDLE_EXIT_MS) process.exit(0);
}, 1000);
setInterval(() => broadcast('ping', { t: Date.now() }), 20000);

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function milestone(root, epoch) {
  return core.readJson(path.join(core.progressDir(root), 'milestones', `epoch-${Number(epoch)}.json`));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/health') return send(res, 200, { app: 'progress-hud', pid: process.pid, clients: clients.size });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(WEB, 'index.html')), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/i18n') {
      const lang = getLang();
      return send(res, 200, { lang, strings: bundle('web', lang) });
    }
    if (url.pathname === '/api/projects') {
      const reg = core.readRegistry();
      return send(res, 200, {
        heartbeat: reg.heartbeat || {},
        projects: projects().map(p => {
          const a = core.aggregate(p.root, { withChecks: false });
          return { id: p.id, name: a.name, root: p.root, pct: a.pct, total: a.total, done: a.done, lastSeen: p.lastSeen, updatedAt: a.updatedAt, stale: a.stale, paused: a.paused };
        }),
      });
    }
    let m = url.pathname.match(/^\/api\/project\/([0-9a-f]{10})$/);
    if (m) {
      const p = findProject(m[1]);
      if (!p) return send(res, 404, { error: 'not_found' });
      const reg = core.readRegistry();
      return send(res, 200, { ...core.aggregate(p.root), heartbeat: reg.heartbeat || {} });
    }
    m = url.pathname.match(/^\/api\/project\/([0-9a-f]{10})\/milestone\/(\d+)$/);
    if (m) {
      const p = findProject(m[1]);
      const ms = p && milestone(p.root, m[2]);
      return ms ? send(res, 200, ms) : send(res, 404, { error: 'not_found' });
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      lastActivity = Date.now();
      req.on('close', () => clients.delete(res));
      return;
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    core.logError('server', e);
    send(res, 500, { error: String(e.message || e) });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') process.exit(0); // another instance (or another app) owns the port
  core.logError('server-listen', e);
  process.exit(1);
});

server.listen(core.PORT, '127.0.0.1', () => {
  try {
    fs.mkdirSync(core.HOME_DIR, { recursive: true });
    fs.writeFileSync(path.join(core.HOME_DIR, 'server.pid'), String(process.pid));
  } catch { /* ignore */ }
});
