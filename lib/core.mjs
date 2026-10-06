// progress-hud core: parsing, storage, merging and aggregation.
// Shared by the hook (Codex + Claude), the server, the CLI and the Claude pane.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { t } from './i18n.mjs';

export const PORT = Number(process.env.PROGRESS_HUD_PORT || 7788);
export const HOME_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'progress-hud');
export const REGISTRY = path.join(HOME_DIR, 'registry.json');
export const FALLBACK_DIR = path.join(HOME_DIR, 'fallback');
export const LOG_FILE = path.join(HOME_DIR, 'hook-error.log');

export const EDIT_REMIND_THRESHOLD = 8;   // file edits without a plan update before reminding
export const STALE_MINUTES = 10;          // activity without plan update → yellow light
export const REPLAN_OVERLAP = 0.5;        // below this overlap a new plan counts as a rewrite

// ---------- small utils ----------

export const now = () => new Date().toISOString();
export const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function normPath(p) {
  if (!p) return p;
  let s = String(p).replace(/^\\\\\?\\/, '');          // strip \\?\ prefix
  s = s.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`); // /c/Users → C:/Users
  s = path.resolve(s);
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

export function logError(where, err) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${now()} [${where}] ${err && err.stack || err}\n`, 'utf8');
  } catch { /* never throw from logging */ }
}

// ---------- JSON storage with OneDrive-friendly retries + fallback ----------

function fallbackPathFor(file) {
  return path.join(FALLBACK_DIR, hash(path.dirname(file)), path.basename(file));
}

export function readJson(file, def = null) {
  const candidates = [file, fallbackPathFor(file), file + '.bak'];
  let best = null, bestTime = -1;
  for (const f of candidates.slice(0, 2)) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs > bestTime) { best = f; bestTime = st.mtimeMs; }
    } catch { /* missing */ }
  }
  for (const f of [best, file + '.bak'].filter(Boolean)) {
    try {
      const txt = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(txt);
    } catch { /* corrupt or locked: try next */ }
  }
  return def;
}

// Atomic write: tmp → rename, keep .bak, retry on OneDrive locks, fall back to LOCALAPPDATA.
// Returns { ok, fallback }.
export function writeJson(file, data) {
  const body = JSON.stringify(data, null, 1);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lastErr;
  for (let i = 0; i < 6; i++) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, body, 'utf8');
      try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch { /* bak is best effort */ }
      fs.renameSync(tmp, file);
      try { fs.rmSync(fallbackPathFor(file), { force: true }); } catch { /* ignore */ }
      return { ok: true, fallback: false };
    } catch (e) {
      lastErr = e;
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      sleepSync(60 * (i + 1));
    }
  }
  try {
    const fb = fallbackPathFor(file);
    fs.mkdirSync(path.dirname(fb), { recursive: true });
    fs.writeFileSync(fb, body, 'utf8');
    logError('writeJson-fallback', `${file}: ${lastErr && lastErr.message}`);
    return { ok: true, fallback: true };
  } catch (e) {
    logError('writeJson', e);
    return { ok: false, fallback: false };
  }
}

function withLock(dir, fn) {
  const lock = path.join(dir, '.lock');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 40; i++) {
    try {
      fs.mkdirSync(lock);
      try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* ignore */ } }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmdirSync(lock); } catch { /* ignore */ }
      sleepSync(50);
    }
  }
  return fn(); // give up waiting rather than block the agent
}

// ---------- project resolution ----------

export function resolveProjectRoot(cwd) {
  const start = normPath(cwd || process.cwd());
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: start, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      const common = normPath(out);
      // <root>/.git → <root>; worktrees share the main repo's common dir
      if (path.basename(common).toLowerCase() === '.git') return path.dirname(common);
      return path.dirname(common);
    }
  } catch { /* not a git repo */ }
  // walk up for an existing .progress folder
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.progress', 'project.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}

export function progressDir(root) { return path.join(root, '.progress'); }
export const projectId = root => hash(normPath(root).toLowerCase());

export function ensureProject(root) {
  const dir = progressDir(root);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# progress-hud data stays out of git\n*\n', 'utf8');
  const pf = path.join(dir, 'project.json');
  let proj = readJson(pf);
  if (!proj) {
    proj = { name: path.basename(root), root, epoch: 1, epochStartedAt: now(), milestones: [] };
    writeJson(pf, proj);
  }
  registerProject(root, proj.name);
  return proj;
}

export function readProject(root) {
  return readJson(path.join(progressDir(root), 'project.json'));
}

// ---------- global registry (lets the server find projects) ----------

export function readRegistry() {
  return readJson(REGISTRY, { projects: {}, heartbeat: {} });
}

export function registerProject(root, name) {
  try {
    withLock(HOME_DIR, () => {
      const reg = readRegistry();
      reg.projects ||= {};
      const id = projectId(root);
      reg.projects[id] = { ...(reg.projects[id] || {}), id, root: normPath(root), name: name || path.basename(root), lastSeen: now() };
      writeJson(REGISTRY, reg);
    });
  } catch (e) { logError('registerProject', e); }
}

export function heartbeat(agent, event, root) {
  try {
    withLock(HOME_DIR, () => {
      const reg = readRegistry();
      reg.heartbeat ||= {};
      reg.heartbeat[agent] = { at: now(), event, root: root ? normPath(root) : undefined };
      if (root && reg.projects && reg.projects[projectId(root)]) reg.projects[projectId(root)].lastSeen = now();
      writeJson(REGISTRY, reg);
    });
  } catch (e) { logError('heartbeat', e); }
}

// ---------- step parsing ----------

const SEP = /\s*(?:›|»|>|→|\/)\s*/;
const ID_RE = /F\d+(?:\.\d+)*/;

export const STATUS_MAP = {
  completed: 'done', complete: 'done', done: 'done',
  in_progress: 'doing', 'in-progress': 'doing', doing: 'doing', active: 'doing',
  pending: 'todo', todo: 'todo', not_started: 'todo',
  deleted: 'deleted', cancelled: 'deleted', canceled: 'deleted',
};
export const normStatus = s => STATUS_MAP[String(s || '').toLowerCase()] || 'todo';

function extractMeta(text) {
  let s = String(text || '').trim();
  let check = null, weight = null;
  s = s.replace(/\[\s*check\s*:\s*([^\]]+)\]/i, (_, c) => { check = c.trim(); return ''; });
  s = s.replace(/\[\s*w\s*[:=]\s*(\d+(?:\.\d+)?)\s*\]/i, (_, w) => { weight = Number(w); return ''; });
  return { s: s.trim(), check, weight };
}

// "F1 Product page › F1.2 Tabs"  |  "[F1.2] Tabs"  |  "F1.2 Tabs"  |  "anything else"
export function parseStep(text) {
  const { s, check, weight } = extractMeta(text);
  const strip = x => x.replace(/^[\s[(（【]+|[\s\])）】:：.、-]+$/g, '').trim();
  const parts = s.split(SEP);
  if (parts.length >= 2) {
    const head = parts[0].match(new RegExp(`^[\\[(（【]?(${ID_RE.source})[\\])）】]?\\s*(.*)$`));
    const tail = parts.slice(1).join(' › ').match(new RegExp(`^[\\[(（【]?(${ID_RE.source})[\\])）】]?[\\s:：.、-]*(.*)$`));
    if (head && tail && tail[1].startsWith(head[1] + '.')) {
      return { id: tail[1], featureId: head[1], featureName: strip(head[2]) || null, name: strip(tail[2]) || tail[1], check, weight, formatted: true };
    }
  }
  const m = s.match(new RegExp(`^[\\[(（【]?(${ID_RE.source})[\\])）】]?[\\s:：.、-]+(.+)$`));
  if (m) {
    const id = m[1];
    return { id, featureId: id.split('.')[0], featureName: id.includes('.') ? null : strip(m[2]), name: strip(m[2]) || id, check, weight, formatted: true };
  }
  const name = s || t('core.emptyStep');
  return { id: 'U-' + hash(name.toLowerCase().replace(/\s+/g, ' ')), featureId: 'U', featureName: null, name, check, weight, formatted: false };
}

// Plan markdown (Claude ExitPlanMode): "## F1 Feature" headings + "- [ ] F1.1 Step" bullets.
export function parsePlanMarkdown(md) {
  const steps = [];
  let feature = null;
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(new RegExp(`^#{1,6}\\s*[\\[(]?(F\\d+)[\\])]?[\\s:：.、-]*(.*)$`));
    if (h) { feature = { id: h[1], name: h[2].trim() }; steps.push({ text: `${h[1]} ${h[2].trim()}`, status: 'pending', featureOnly: true }); continue; }
    const b = line.match(/^(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/);
    if (b && new RegExp(`^[\\[(]?${ID_RE.source}`).test(b[2])) {
      const st = b[1] && b[1].toLowerCase() === 'x' ? 'completed' : 'pending';
      const p = parseStep(b[2]);
      const text = feature && p.featureId === feature.id && !b[2].includes('›') ? `${feature.id} ${feature.name} › ${b[2]}` : b[2];
      steps.push({ text, status: st });
    }
  }
  // keep feature-only headings only as name carriers: drop them when they have children
  const withKids = new Set(steps.filter(s => !s.featureOnly).map(s => parseStep(s.text).featureId));
  return steps.filter(s => !(s.featureOnly && withKids.has(parseStep(s.text).featureId)))
    .map(s => ({ text: s.text, status: s.status }));
}

// ---------- session state ----------

export function sessionFile(root, agent, sessionId) {
  const safe = String(sessionId || 'default').replace(/[^\w.-]/g, '_').slice(0, 80);
  return path.join(progressDir(root), 'sessions', `${agent}-${safe}.json`);
}

export function loadSession(root, agent, sessionId, epoch) {
  const f = sessionFile(root, agent, sessionId);
  let s = readJson(f);
  if (!s) {
    s = {
      agent, sessionId, epoch, startedAt: now(), updatedAt: now(),
      lastPlanAt: null, lastActivityAt: null, turnStartAt: null,
      editsSincePlan: 0, editsThisTurn: 0, remindedAtEdits: 0,
      paused: false, stopBlockedAt: null, formatNags: 0,
      versions: [], taskMap: {}, subagents: {}, raw: [],
    };
  }
  if (epoch && s.epoch !== epoch) {
    // project moved to a new milestone; this session starts clean
    s.epoch = epoch; s.versions = []; s.taskMap = {}; s.subagents = {};
  }
  s._file = f;
  return s;
}

export function saveSession(s) {
  const f = s._file;
  const data = { ...s };
  delete data._file;
  data.updatedAt = now();
  return writeJson(f, data);
}

const currentVersion = s => s.versions[s.versions.length - 1];
const normName = n => String(n || '').toLowerCase().replace(/\s+/g, '');

function overlapRatio(oldItems, parsed) {
  const live = Object.values(oldItems).filter(i => !i.missing && i.status !== 'deleted');
  if (!live.length) return 1;
  const keys = new Set(live.map(i => i.key));
  const names = new Set(live.map(i => normName(i.name)));
  const hits = parsed.filter(p => keys.has(p.id) || names.has(normName(p.name))).length;
  return hits / Math.max(live.length, parsed.length);
}

function itemFrom(p, status, order, agent, prev) {
  const t = now();
  const st = normStatus(status);
  return {
    key: p.id, id: p.id, name: p.name,
    featureId: p.featureId, featureName: p.featureName || prev?.featureName || null,
    status: st, order, missing: false,
    check: p.check ?? prev?.check ?? null, weight: p.weight ?? prev?.weight ?? null,
    formatted: p.formatted,
    by: agent,
    createdAt: prev?.createdAt || t,
    updatedAt: prev && prev.status === st && prev.name === p.name ? prev.updatedAt : t,
    startedAt: st === 'doing' ? (prev?.startedAt || t) : (prev?.startedAt || null),
    doneAt: st === 'done' ? (prev?.doneAt || t) : null,
  };
}

// steps: [{ text, status }]. full: the list is the whole plan (Codex update_plan, TodoWrite).
// Returns { replanned, unformatted }.
export function applyPlan(s, steps, { full = true, agent = s.agent, reason = 'update' } = {}) {
  const parsed = steps.map(st => ({ ...parseStep(st.text), status: st.status }));
  // de-duplicate ids within one payload (second occurrence gets a suffix)
  const seen = new Map();
  for (const p of parsed) {
    const n = seen.get(p.id) || 0;
    seen.set(p.id, n + 1);
    if (n) p.id = `${p.id}#${n + 1}`;
  }
  let v = currentVersion(s);
  let replanned = false;
  if (!v) {
    v = { v: 1, createdAt: now(), reason, items: {} };
    s.versions.push(v);
  } else if (full && Object.keys(v.items).length >= 2 && overlapRatio(v.items, parsed) < REPLAN_OVERLAP) {
    v = { v: v.v + 1, createdAt: now(), reason: 'replan', items: {} };
    s.versions.push(v);
    replanned = true;
  }
  // carry feature names learned from any step
  const featNames = {};
  for (const it of Object.values(v.items)) if (it.featureName) featNames[it.featureId] = it.featureName;
  for (const p of parsed) if (p.featureName) featNames[p.featureId] = p.featureName;

  const present = new Set();
  parsed.forEach((p, i) => {
    let prev = v.items[p.id];
    if (!prev && !p.formatted) {
      // unformatted rename tolerance: match by name
      prev = Object.values(v.items).find(it => normName(it.name) === normName(p.name));
      if (prev) p.id = prev.key;
    }
    const it = itemFrom(p, p.status, i, agent, prev);
    it.featureName = featNames[it.featureId] || it.featureName;
    v.items[it.key] = it;
    present.add(it.key);
  });
  if (full) {
    for (const it of Object.values(v.items)) {
      if (!present.has(it.key) && !it.missing) { it.missing = true; it.missingAt = now(); }
    }
  }
  for (const it of Object.values(v.items)) if (featNames[it.featureId]) it.featureName = featNames[it.featureId];
  s.lastPlanAt = now();
  s.editsSincePlan = 0;
  s.remindedAtEdits = 0;
  return { replanned, unformatted: parsed.filter(p => !p.formatted).map(p => p.name) };
}

// Incremental single-item update (Claude TaskCreate / TaskUpdate).
export function applyTask(s, { taskId, subject, status, deleted, agent = s.agent }) {
  let v = currentVersion(s);
  if (!v) { v = { v: 1, createdAt: now(), reason: 'tasks', items: {} }; s.versions.push(v); }
  let key = taskId != null ? s.taskMap[taskId] : null;
  const prev = key ? v.items[key] : null;
  if (!prev && !subject) return { unformatted: [] };
  const p = parseStep(subject || prev.name && `${prev.id} ${prev.name}`);
  if (prev) { p.id = prev.key; if (!subject) { p.name = prev.name; p.featureName = prev.featureName; p.formatted = prev.formatted; } }
  const it = itemFrom(p, deleted ? 'deleted' : (status || prev?.status === 'done' && 'completed' || prev?.status === 'doing' && 'in_progress' || 'pending'), prev ? prev.order : Object.keys(v.items).length, agent, prev);
  if (!it.featureName) it.featureName = Object.values(v.items).find(x => x.featureId === it.featureId && x.featureName)?.featureName || null;
  v.items[it.key] = it;
  if (taskId != null) s.taskMap[taskId] = it.key;
  s.lastPlanAt = now();
  s.editsSincePlan = 0;
  s.remindedAtEdits = 0;
  return { unformatted: p.formatted ? [] : [p.name] };
}

// Subagent plans hang under the main plan's in-progress item.
export function applySubagentPlan(s, agentId, agentType, steps) {
  const main = currentVersion(s);
  const doing = main && Object.values(main.items).filter(i => i.status === 'doing' && !i.missing).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const sub = s.subagents[agentId] ||= { agentId, agentType: agentType || 'subagent', parentKey: doing?.key || null, createdAt: now(), items: {} };
  const present = new Set();
  steps.forEach((st, i) => {
    const p = parseStep(st.text);
    const key = p.formatted ? p.id : 'S-' + hash(normName(st.text));
    sub.items[key] = { key, name: p.formatted ? p.name : st.text, status: normStatus(st.status), order: i, updatedAt: now() };
    present.add(key);
  });
  for (const it of Object.values(sub.items)) it.missing = !present.has(it.key);
  sub.updatedAt = now();
}

// ---------- verification (safe only: file exists / grep text) ----------

function insideRoot(root, rel) {
  const abs = path.resolve(root, rel);
  const r = path.resolve(root);
  return abs.toLowerCase() === r.toLowerCase() || abs.toLowerCase().startsWith(r.toLowerCase() + path.sep) ? abs : null;
}

export function runCheck(root, check) {
  if (!check) return null;
  const m = check.match(/^(file|grep)\s*[:：]?\s*(.+)$/i);
  if (!m) return { ok: false, detail: t('core.checkUnknown', { check }) };
  const kind = m[1].toLowerCase();
  if (kind === 'file') {
    const rel = m[2].trim().replace(/^["']|["']$/g, '');
    const abs = insideRoot(root, rel);
    if (!abs) return { ok: false, detail: t('core.checkOutside') };
    return { ok: fs.existsSync(abs), detail: t('core.checkFile', { path: rel }) };
  }
  const g = m[2].trim().match(/^("[^"]+"|'[^']+'|\S+)\s+(.+)$/);
  if (!g) return { ok: false, detail: t('core.checkGrepFormat') };
  const rel = g[1].replace(/^["']|["']$/g, '');
  const needle = g[2].trim().replace(/^["']|["']$/g, '');
  const abs = insideRoot(root, rel);
  if (!abs) return { ok: false, detail: t('core.checkOutside') };
  try {
    const st = fs.statSync(abs);
    if (st.size > 5 * 1024 * 1024) return { ok: false, detail: t('core.checkTooBig') };
    return { ok: fs.readFileSync(abs, 'utf8').includes(needle), detail: t('core.checkGrep', { path: rel, text: needle }) };
  } catch { return { ok: false, detail: t('core.checkMissing', { path: rel }) }; }
}

// ---------- aggregation (what the UIs show) ----------

export function listSessions(root) {
  const dir = path.join(progressDir(root), 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { /* none */ }
  // include sessions only present in fallback storage
  try {
    const fb = path.join(FALLBACK_DIR, hash(dir));
    for (const f of fs.readdirSync(fb)) if (f.endsWith('.json') && !files.includes(f)) files.push(f);
  } catch { /* none */ }
  return files.map(f => {
    const s = readJson(path.join(dir, f));
    if (s) s._file = path.join(dir, f);
    return s;
  }).filter(Boolean);
}

function leafStats(nodes) {
  let total = 0, done = 0;
  for (const n of nodes) {
    if (n.status === 'deleted' || n.missing) continue;
    if (n.children && n.children.length) {
      const c = leafStats(n.children);
      total += c.total; done += c.done;
    } else {
      const w = n.weight || 1;
      total += w; if (n.status === 'done') done += w;
    }
  }
  return { total, done };
}

function buildTree(items, subagents) {
  const features = new Map();
  const sorted = [...items].sort((a, b) => {
    const fa = a.featureId === 'U' ? 1e9 : Number(a.featureId.slice(1)) || 0;
    const fb = b.featureId === 'U' ? 1e9 : Number(b.featureId.slice(1)) || 0;
    if (fa !== fb) return fa - fb;
    const pa = a.id.replace(/^F/, '').split(/[.#]/).map(Number), pb = b.id.replace(/^F/, '').split(/[.#]/).map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? -1) - (pb[i] ?? -1);
      if (d && !Number.isNaN(d)) return d;
    }
    return a.order - b.order;
  });
  const byKey = new Map(sorted.map(i => [i.key, { ...i, children: [] }]));
  for (const node of byKey.values()) {
    if (!features.has(node.featureId)) {
      const name = node.featureId === 'U' ? t('core.uncategorized') : node.featureName || node.featureId;
      features.set(node.featureId, { key: node.featureId, id: node.featureId, name, isFeature: true, status: 'todo', children: [] });
    }
    const f = features.get(node.featureId);
    if (node.featureName && f.name === f.id && f.id !== 'U') f.name = node.featureName;
    if (node.key === node.featureId) { f.selfItem = node; continue; }
    // parent: nearest existing ancestor id
    let parent = null;
    const segs = node.id.split('#')[0].split('.');
    for (let k = segs.length - 1; k >= 2; k--) {
      const pid = segs.slice(0, k).join('.');
      if (byKey.has(pid) && pid !== node.key) { parent = byKey.get(pid); break; }
    }
    (parent || f).children.push(node);
  }
  // subagents nest under their parent item
  for (const sub of Object.values(subagents || {})) {
    const host = sub.parentKey && byKey.get(sub.parentKey);
    const kids = Object.values(sub.items).sort((a, b) => a.order - b.order).map(x => ({ ...x, isSub: true, agentType: sub.agentType, children: [] }));
    if (host) host.subagents = (host.subagents || []).concat([{ agentType: sub.agentType, items: kids }]);
  }
  const out = [...features.values()];
  const finish = n => {
    for (const c of n.children) finish(c);
    if (n.children.length) {
      const st = leafStats(n.children);
      n.total = st.total; n.done = st.done;
      n.pct = st.total ? Math.round(st.done / st.total * 100) : 0;
      n.status = st.total && st.done === st.total ? 'done' : n.children.some(c => c.status === 'doing' || c.status === 'done') ? 'doing' : 'todo';
    } else if (n.isFeature && n.selfItem) {
      n.status = n.selfItem.status; n.total = 1; n.done = n.status === 'done' ? 1 : 0; n.pct = n.done * 100;
      Object.assign(n, { check: n.selfItem.check, by: n.selfItem.by, verified: n.selfItem.verified });
    } else {
      n.total = n.status === 'deleted' || n.missing ? 0 : 1; n.done = n.status === 'done' ? 1 : 0; n.pct = n.done * 100;
    }
  };
  out.forEach(finish);
  return out;
}

const minutesSince = iso => iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity;

export function aggregate(root, { withChecks = true } = {}) {
  root = normPath(root);
  const proj = readProject(root) || { name: path.basename(root), epoch: 1, milestones: [] };
  const all = listSessions(root);
  const sessions = all.filter(s => (s.epoch || 1) === (proj.epoch || 1) && s.versions && s.versions.length);
  // merge items: newest update wins per key
  const merged = new Map();
  const doingBy = new Map();
  for (const s of sessions) {
    const v = s.versions[s.versions.length - 1];
    for (const it of Object.values(v.items)) {
      const cur = merged.get(it.key);
      const tag = `${s.agent}·${String(s.sessionId).slice(-4)}`;
      if (!cur || it.updatedAt > cur.updatedAt) merged.set(it.key, { ...it, by: tag, agent: s.agent, paused: !!s.paused });
      if (it.status === 'doing' && !it.missing) doingBy.set(it.key, [...(doingBy.get(it.key) || []), tag]);
    }
  }
  const items = [...merged.values()];
  if (withChecks) {
    for (const it of items) {
      if (it.status === 'done' && it.check) {
        const r = runCheck(root, it.check);
        it.verified = r.ok ? 'pass' : 'fail';
        it.verifyDetail = r.detail;
      } else if (it.status === 'done') it.verified = 'claimed';
      if (doingBy.has(it.key)) it.workers = doingBy.get(it.key);
    }
  }
  const subagents = Object.assign({}, ...sessions.map(s => s.subagents || {}));
  const tree = buildTree(items, subagents);
  const st = leafStats(tree);
  const live = items.filter(i => !i.missing && i.status !== 'deleted');
  const current = live.filter(i => i.status === 'doing');
  const next = live.filter(i => i.status === 'todo').sort((a, b) => a.featureId.localeCompare(b.featureId, undefined, { numeric: true }) || a.id.localeCompare(b.id, undefined, { numeric: true }))[0] || null;

  const lastPlanAt = sessions.map(s => s.lastPlanAt).filter(Boolean).sort().pop() || null;
  const lastActivityAt = sessions.map(s => s.lastActivityAt).filter(Boolean).sort().pop() || null;
  const warnings = [];
  const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
  const stale = pct < 100 && lastActivityAt && lastPlanAt && lastActivityAt > lastPlanAt && minutesSince(lastPlanAt) > STALE_MINUTES;
  if (stale) warnings.push({ level: 'warn', code: 'stale', text: t('core.warnStale', { minutes: Math.round(minutesSince(lastPlanAt)) }) });
  const unformatted = live.filter(i => i.featureId === 'U').length;
  if (unformatted && live.length >= 3) warnings.push({ level: 'info', code: 'unformatted', text: t('core.warnUnformatted', { count: unformatted }) });
  const failed = items.filter(i => i.verified === 'fail').length;
  if (failed) warnings.push({ level: 'warn', code: 'verify', text: t('core.warnVerify', { count: failed }) });
  const fbDir = path.join(FALLBACK_DIR, hash(path.join(progressDir(root), 'sessions')));
  try { if (fs.readdirSync(fbDir).length) warnings.push({ level: 'warn', code: 'fallback', text: t('core.warnFallback') }); } catch { /* none */ }

  return {
    id: projectId(root), root, name: proj.name, epoch: proj.epoch || 1, epochStartedAt: proj.epochStartedAt,
    milestones: proj.milestones || [],
    total: st.total, done: st.done, pct,
    current: current.map(i => ({ key: i.key, name: i.name, featureName: i.featureName, workers: i.workers || [i.by] })),
    next: next && { key: next.key, name: next.name, featureName: next.featureName },
    paused: sessions.length > 0 && sessions.every(s => s.paused),
    tree,
    sessions: all.map(s => ({
      agent: s.agent, sessionId: s.sessionId, epoch: s.epoch, active: (s.epoch || 1) === (proj.epoch || 1),
      updatedAt: s.updatedAt, lastPlanAt: s.lastPlanAt, lastActivityAt: s.lastActivityAt, paused: !!s.paused,
      versions: (s.versions || []).map(v => ({ v: v.v, createdAt: v.createdAt, reason: v.reason, count: Object.keys(v.items).length,
        items: Object.values(v.items).sort((a, b) => a.order - b.order).map(i => ({ id: i.id, name: i.name, featureName: i.featureName, status: i.status, missing: i.missing })) })),
    })),
    lastPlanAt, lastActivityAt, stale: !!stale, warnings,
    updatedAt: sessions.map(s => s.updatedAt).sort().pop() || null,
  };
}

// Archive the finished epoch when a new, unrelated plan starts. Returns true if archived.
export function maybeStartMilestone(root, incomingSteps) {
  const agg = aggregate(root, { withChecks: false });
  if (!agg.total || agg.pct < 100) return false;
  const parsed = incomingSteps.map(s => parseStep(s.text));
  // compare step names, not numbers: a new task usually starts again at F1.1
  const names = new Set();
  const walk = n => { if (!n.isFeature) names.add(normName(n.name)); (n.children || []).forEach(walk); };
  agg.tree.forEach(walk);
  const hits = parsed.filter(p => names.has(normName(p.name))).length;
  if (parsed.length && hits / parsed.length >= REPLAN_OVERLAP) return false;
  return withLock(progressDir(root), () => {
    const pf = path.join(progressDir(root), 'project.json');
    const proj = readJson(pf) || { name: path.basename(root), epoch: 1, milestones: [] };
    if ((proj.epoch || 1) !== agg.epoch) return false; // someone else already archived
    const title = agg.tree.filter(f => f.id !== 'U').map(f => f.name).slice(0, 3).join(t('core.listSep')) || t('core.milestoneFallback');
    const ms = { epoch: proj.epoch || 1, title, startedAt: proj.epochStartedAt, completedAt: agg.lastPlanAt || now(), total: agg.total, tree: agg.tree };
    writeJson(path.join(progressDir(root), 'milestones', `epoch-${ms.epoch}.json`), ms);
    proj.milestones = [...(proj.milestones || []), { epoch: ms.epoch, title, startedAt: ms.startedAt, completedAt: ms.completedAt, total: ms.total }];
    proj.epoch = (proj.epoch || 1) + 1;
    proj.epochStartedAt = now();
    writeJson(pf, proj);
    return true;
  });
}

// Short text for prompt injection and status lines.
export function summaryLine(agg, { long = false } = {}) {
  if (!agg || !agg.total) return '';
  const cur = agg.current.map(c => label(c.key, c.name)).join(t('core.listSep')) || t('core.none');
  const nxt = agg.next ? label(agg.next.key, agg.next.name) : t('core.none');
  let s = t('core.summary', { pct: agg.pct, done: agg.done, total: agg.total, current: cur, next: nxt });
  if (long) {
    const lines = [];
    const walk = (n, depth) => {
      const mark = n.status === 'done' ? '[x]' : n.status === 'doing' ? '[~]' : n.status === 'deleted' ? '[-]' : '[ ]';
      lines.push(`${'  '.repeat(depth)}${mark} ${n.isFeature ? (n.id === 'U' ? n.name : n.id + ' ' + n.name) : label(n.key, n.name)}${n.children.length ? ` (${n.pct}%)` : ''}${n.missing ? t('core.noLongerListed') : ''}`);
      n.children.forEach(c => walk(c, depth + 1));
    };
    agg.tree.forEach(f => walk(f, 0));
    s += '\n' + lines.join('\n');
  }
  return s;
}

// Display label: unformatted steps (key U-…) show only their name.
export const label = (key, name) => (String(key).startsWith('U-') ? name : `${key} ${name}`);

export function dashboardUrl(root) {
  return `http://127.0.0.1:${PORT}/?p=${projectId(root)}`;
}
