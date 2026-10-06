// install / uninstall / statusline / doctor for progress-hud.
//
// Marketplace installs need none of this except the optional `statusline` step.
// `install` is for a local clone: it registers the clone as a Claude Code plugin folder
// (CLAUDE_CODE_PLUGIN_DIRS) and adds the Codex hooks to ~/.codex/hooks.json.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import * as core from '../lib/core.mjs';
import { t, getLang } from '../lib/i18n.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const fwd = p => p.replace(/\\/g, '/');
const HOOK = fwd(path.join(APP, 'bin', 'hook.mjs'));
const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex');
const CLAUDE_DIR = path.join(HOME, '.claude');
const CODEX_HOOKS = path.join(CODEX_DIR, 'hooks.json');
const CODEX_AGENTS = path.join(CODEX_DIR, 'AGENTS.md');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const CONFIG = path.join(core.HOME_DIR, 'config.json');
export const HUD_CMD = path.join(core.HOME_DIR, 'hud-extra.cmd');
const MARK_START = '<!-- progress-hud:start -->';
const MARK_END = '<!-- progress-hud:end -->';
const TAG = 'progress-hud';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const b = `${file}.bak-progress-hud-${stamp}`;
  fs.copyFileSync(file, b);
  return b;
}
const readJsonFile = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
const writeJsonFile = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf8'); };

// Stable launchers (status line + CLI): always point at the progress-hud copy that ran last
// (a marketplace update moves the plugin to a new versioned folder).
export const CLI_CMD = path.join(core.HOME_DIR, 'progress.cmd');
export function writeHudShim(appRoot = APP) {
  const cli = path.join(appRoot, 'bin', 'progress.mjs');
  const head = '@echo off\r\nrem written by progress-hud; points at the installed copy\r\n';
  for (const [file, body] of [[HUD_CMD, `${head}node "${cli}" hud\r\n`], [CLI_CMD, `${head}node "${cli}" %*\r\n`]]) {
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) continue;
      fs.mkdirSync(core.HOME_DIR, { recursive: true });
      fs.writeFileSync(file, body, 'utf8');
    } catch (e) { core.logError('writeHudShim', e); }
  }
}

// Older versions wrote rules into AGENTS.md / CLAUDE.md; the SessionStart hook injects them now.
function removeBlock(file) {
  if (!fs.existsSync(file)) return false;
  const txt = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`\\n*${MARK_START}[\\s\\S]*?${MARK_END}\\n?`);
  if (!re.test(txt)) return false;
  backup(file);
  fs.writeFileSync(file, txt.replace(re, '\n'), 'utf8');
  return true;
}

const cmdFor = agent => ({ type: 'command', command: `node ${HOOK} ${agent}`, timeout: 15 });
const isOurs = h => { const c = String(h?.command || ''); return c.includes(HOOK) || c.includes(TAG); };
const isOurDir = d => path.resolve(d) === APP || d.includes(TAG);

function mergeHooks(hooks, agent, events) {
  hooks = stripHooks(hooks || {});
  for (const [event, matcher] of Object.entries(events)) {
    const group = { hooks: [cmdFor(agent)] };
    if (matcher) group.matcher = matcher;
    hooks[event] = [...(hooks[event] || []), group];
  }
  return hooks;
}
function stripHooks(hooks) {
  if (!hooks) return hooks;
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = hooks[ev].map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  return hooks;
}

const CODEX_EVENTS = {
  SessionStart: 'startup|resume|clear|compact',
  UserPromptSubmit: null,
  PostToolUse: '^(update_plan|apply_patch|Edit|Write|Bash|shell|exec_command|local_shell)$',
  Stop: null,
};

// claude-hud integration; returns a log line or null when nothing changed.
function addStatusLine(cs) {
  const cmd = cs.statusLine?.command;
  if (!cmd) return t('install.hudSkipped');
  if (cmd.includes(HUD_CMD)) return null;
  const extra = cmd.match(/--extra-cmd\s+"([^"]+)"/);
  if (extra && extra[1].includes(TAG)) {
    // an older progress-hud launcher: switch to the stable one
    cs.statusLine.command = cmd.replace(extra[0], `--extra-cmd "${HUD_CMD}"`);
    return t('install.hudAdded');
  }
  if (extra) {
    // keep the user's own extra-cmd: progress-hud runs it and shows its label next to the progress
    writeJsonFile(CONFIG, { ...readJsonFile(CONFIG, {}), chainExtraCmd: extra[1] });
    cs.statusLine.command = cmd.replace(extra[0], `--extra-cmd "${HUD_CMD}"`);
    return t('install.hudChained', { cmd: extra[1] });
  }
  if (cmd.includes('claude-hud') && cmd.includes('dist/index.js"')) {
    cs.statusLine.command = cmd.replace('dist/index.js"', `dist/index.js" --extra-cmd "${HUD_CMD}"`);
    return t('install.hudAdded');
  }
  return t('install.hudSkipped');
}

function removeStatusLine(cs) {
  const cmd = cs.statusLine?.command;
  if (!cmd) return;
  const extra = cmd.match(/--extra-cmd\s+"([^"]+)"/);
  if (!extra || !(extra[1] === HUD_CMD || extra[1].includes(TAG))) return;
  const chain = readJsonFile(CONFIG, {}).chainExtraCmd;
  cs.statusLine.command = chain ? cmd.replace(extra[0], `--extra-cmd "${chain}"`) : cmd.replace(` ${extra[0]}`, '');
}

function removeLegacy(cs, log) {
  // hooks an older version put straight into settings.json (the plugin folder carries them now)
  const before = JSON.stringify(cs.hooks || {});
  cs.hooks = stripHooks(cs.hooks);
  if (cs.hooks && !Object.keys(cs.hooks).length) delete cs.hooks;
  if (JSON.stringify(cs.hooks || {}) !== before) log.push(t('install.legacyHooks'));
  for (const f of [CODEX_AGENTS, CLAUDE_MD]) if (removeBlock(f)) log.push(t('install.legacyRules', { file: f }));
}

export async function install() {
  const log = [];
  writeHudShim();
  // ---- Codex ----
  let b = backup(CODEX_HOOKS); if (b) log.push(t('install.backup', { file: b }));
  const ch = readJsonFile(CODEX_HOOKS, {});
  ch.hooks = mergeHooks(ch.hooks, 'codex', CODEX_EVENTS);
  writeJsonFile(CODEX_HOOKS, ch);
  log.push(t('install.wrote', { file: CODEX_HOOKS }));
  // ---- Claude ----
  b = backup(CLAUDE_SETTINGS); if (b) log.push(t('install.backup', { file: b }));
  const cs = readJsonFile(CLAUDE_SETTINGS, {});
  removeLegacy(cs, log);
  cs.env ||= {};
  const dirs = String(cs.env.CLAUDE_CODE_PLUGIN_DIRS || '').split(';').filter(Boolean).filter(d => !isOurDir(d));
  cs.env.CLAUDE_CODE_PLUGIN_DIRS = [...dirs, APP].join(';');
  const line = addStatusLine(cs);
  if (line) log.push(line);
  writeJsonFile(CLAUDE_SETTINGS, cs);
  log.push(t('install.wrote', { file: CLAUDE_SETTINGS }));
  console.log(log.join('\n'));
  console.log('\n' + t('install.done', { url: `http://127.0.0.1:${core.PORT}` }));
}

// Status line only (for marketplace installs).
export async function statusline() {
  writeHudShim();
  const b = backup(CLAUDE_SETTINGS); if (b) console.log(t('install.backup', { file: b }));
  const cs = readJsonFile(CLAUDE_SETTINGS, {});
  const line = addStatusLine(cs);
  writeJsonFile(CLAUDE_SETTINGS, cs);
  console.log(line || t('install.hudAlready'));
}

export async function uninstall() {
  for (const f of [CODEX_HOOKS, CLAUDE_SETTINGS]) { const b = backup(f); if (b) console.log(t('install.backup', { file: b })); }
  const ch = readJsonFile(CODEX_HOOKS, null);
  if (ch) { ch.hooks = stripHooks(ch.hooks); writeJsonFile(CODEX_HOOKS, ch); }
  const cs = readJsonFile(CLAUDE_SETTINGS, null);
  if (cs) {
    removeLegacy(cs, []);
    if (cs.env?.CLAUDE_CODE_PLUGIN_DIRS) {
      const rest = cs.env.CLAUDE_CODE_PLUGIN_DIRS.split(';').filter(d => d && !isOurDir(d));
      if (rest.length) cs.env.CLAUDE_CODE_PLUGIN_DIRS = rest.join(';'); else delete cs.env.CLAUDE_CODE_PLUGIN_DIRS;
    }
    removeStatusLine(cs);
    writeJsonFile(CLAUDE_SETTINGS, cs);
  } else {
    for (const f of [CODEX_AGENTS, CLAUDE_MD]) removeBlock(f);
  }
  console.log(t('install.removed'));
}

function alive() {
  return new Promise(r => {
    const q = http.get({ host: '127.0.0.1', port: core.PORT, path: '/health', timeout: 600 }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => r(b.includes('progress-hud')));
    });
    q.on('error', () => r(false)); q.on('timeout', () => { q.destroy(); r(false); });
  });
}

export async function doctor() {
  const ok = (c, msg) => console.log(`${c ? '✓' : '✗'} ${msg}`);
  const info = msg => console.log(`· ${msg}`);
  const reg = core.readRegistry();
  for (const a of ['codex', 'claude']) {
    const h = reg.heartbeat?.[a];
    ok(!!h, t('install.dHook', { agent: a, info: h ? `${h.at} (${h.event})` : t('install.dHookNever') }));
  }
  ok(await alive(), t('install.dServer', { url: `http://127.0.0.1:${core.PORT}` }));
  const cs = readJsonFile(CLAUDE_SETTINGS, {});
  const ch = readJsonFile(CODEX_HOOKS, {});
  const codexLocal = Object.keys(CODEX_EVENTS).filter(e => (ch.hooks?.[e] || []).some(g => g.hooks.some(isOurs))).length;
  if (codexLocal) info(t('install.dCodexLocal', { n: codexLocal }));
  if (String(cs.env?.CLAUDE_CODE_PLUGIN_DIRS || '').split(';').some(isOurDir)) info(t('install.dClaudeLocal'));
  info(String(cs.statusLine?.command || '').includes(HUD_CMD) ? t('install.dStatusOn') : t('install.dStatusOff'));
  info(t('install.dProjects', { n: Object.keys(reg.projects || {}).length }));
  info(t('install.dLang', { lang: getLang() }));
  if (fs.existsSync(core.LOG_FILE)) info(t('install.dLog', { file: core.LOG_FILE }));
}
