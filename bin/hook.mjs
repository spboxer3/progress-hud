#!/usr/bin/env node
// One hook entry for both agents:  node hook.mjs codex|claude   (event JSON on stdin)
// Never blocks the agent on its own failure: every path ends in exit 0.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../lib/core.mjs';
import { t } from '../lib/i18n.mjs';
import { rulesText } from '../lib/rules.mjs';

const AGENT = (process.argv[2] || 'codex').toLowerCase();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const killer = setTimeout(() => process.exit(0), 9000);

const PAUSE_RE = /(暫停|先這樣|先到這|明天再|改天再|晚點再|稍後再|\bpause\b|stop here|that'?s all for now)/i;
const RESUME_RE = /(繼續|接著做|開始做|\bcontinue\b|\bresume\b|go on)/i;
const MUTATING_SHELL = /(>|\bmv\b|\bcp\b|\brm\b|\bdel\b|sed\s+-i|\bmkdir\b|\btouch\b|npm\s+(i|install|run\s+build)|pnpm|yarn\s+add|git\s+(commit|apply|checkout|merge|rebase)|Set-Content|Out-File|Add-Content|New-Item|Remove-Item|Copy-Item|Move-Item|tee\b)/i;
const EDIT_TOOLS = /^(apply_patch|Edit|Write|MultiEdit|NotebookEdit|str_replace_editor|write_file|edit_file)$/;
const SHELL_TOOLS = /^(Bash|PowerShell|shell|exec_command|local_shell)$/;
const PLAN_TOOLS = /^(update_plan|TodoWrite|TaskCreate|TaskUpdate|ExitPlanMode)$/;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function out(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
}

const say = (key, vars) => `${t('hook.prefix')} ${t(key, vars)}`;
const planTool = () => t(AGENT === 'codex' ? 'hook.toolCodex' : 'hook.toolClaude');

function ctx(event, text, extra = {}) {
  return { ...extra, hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function serverAlive() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: core.PORT, path: '/health', timeout: 400 }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve(body.includes('progress-hud')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureServer() {
  if (process.env.PROGRESS_HUD_NO_SERVER) return;
  if (await serverAlive()) return;
  try {
    const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch (e) { core.logError('ensureServer', e); }
}

const hasProject = root => fs.existsSync(path.join(core.progressDir(root), 'project.json'));

function planStepsFrom(tool, input, response) {
  if (tool === 'update_plan') {
    const plan = input?.plan || input?.steps || [];
    return plan.map(p => ({ text: p.step ?? p.content ?? p.title ?? '', status: p.status }));
  }
  if (tool === 'TodoWrite') {
    const todos = input?.todos || response?.newTodos || [];
    return todos.map(t => ({ text: t.content ?? '', status: t.status }));
  }
  if (tool === 'ExitPlanMode') {
    return core.parsePlanMarkdown(input?.plan || response?.plan || '');
  }
  return null;
}

function taskFrom(tool, input, response) {
  if (tool === 'TaskCreate') {
    let r = response;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { /* keep string */ } }
    let id = r?.task?.id ?? r?.id;
    if (id == null && typeof r === 'string') id = (r.match(/#?(\d+)/) || [])[1];
    return { taskId: id != null ? String(id) : null, subject: input?.subject || r?.task?.subject, status: 'pending' };
  }
  if (tool === 'TaskUpdate') {
    return { taskId: String(input?.taskId), subject: input?.subject, status: input?.status === 'deleted' ? undefined : input?.status, deleted: input?.status === 'deleted' };
  }
  return null;
}

async function onPlanTool(ev, root) {
  const tool = ev.tool_name;
  const input = ev.tool_input || {};
  const response = ev.tool_response;
  const subagent = ev.agent_id && ev.agent_id !== ev.session_id ? ev.agent_id : null;
  const steps = planStepsFrom(tool, input, response);
  const task = steps ? null : taskFrom(tool, input, response);
  if (steps && !steps.length) return null;
  if (tool === 'ExitPlanMode' && steps && !steps.some(s => core.parseStep(s.text).formatted)) return null;

  const firstTime = !hasProject(root);
  if (!subagent && steps && !firstTime) core.maybeStartMilestone(root, steps);
  const proj = core.ensureProject(root);
  const s = core.loadSession(root, AGENT, ev.session_id, proj.epoch || 1);
  let result = { unformatted: [] };
  if (subagent) {
    if (steps) core.applySubagentPlan(s, subagent, ev.agent_type, steps);
  } else if (steps) {
    result = core.applyPlan(s, steps, { full: true, reason: tool === 'ExitPlanMode' ? 'plan' : 'update' });
  } else if (task) {
    result = core.applyTask(s, task);
  }
  s.paused = false;
  s.raw = [...(s.raw || []), { at: core.now(), tool, input }].slice(-5);
  const notes = [];
  const live = Object.values(s.versions.at(-1)?.items || {}).filter(i => !i.missing && i.status !== 'deleted');
  if (result.unformatted?.length && live.length >= 3 && s.formatNags < 3) {
    s.formatNags++;
    notes.push(say('hook.formatNag', { steps: result.unformatted.slice(0, 5).join(t('hook.stepSep')) }));
  }
  if (result.replanned) notes.push(say('hook.replanned'));
  core.saveSession(s);
  await ensureServer();
  const agg = core.aggregate(root, { withChecks: false });
  const extra = firstTime ? { systemMessage: t('hook.started', { url: core.dashboardUrl(root) }) } : {};
  if (notes.length) return ctx('PostToolUse', notes.join('\n'), extra);
  if (firstTime) return extra;
  if (agg.pct === 100 && agg.total) return { systemMessage: t('hook.allDone', { total: agg.total }) };
  return null;
}

function onActivity(ev, root) {
  if (!hasProject(root)) return null;
  const tool = ev.tool_name;
  if (SHELL_TOOLS.test(tool) && !MUTATING_SHELL.test(String(ev.tool_input?.command || ev.tool_input?.cmd || ''))) return null;
  if (ev.agent_id && ev.agent_id !== ev.session_id) return null; // subagent edits count via the parent
  const proj = core.readProject(root);
  const s = core.loadSession(root, AGENT, ev.session_id, proj?.epoch || 1);
  s.editsSincePlan = (s.editsSincePlan || 0) + 1;
  s.editsThisTurn = (s.editsThisTurn || 0) + 1;
  s.lastActivityAt = core.now();
  let reply = null;
  const agg = core.aggregate(root, { withChecks: false });
  if (agg.total && agg.pct < 100 && !s.paused && s.editsSincePlan >= core.EDIT_REMIND_THRESHOLD && s.editsSincePlan - (s.remindedAtEdits || 0) >= core.EDIT_REMIND_THRESHOLD) {
    s.remindedAtEdits = s.editsSincePlan;
    reply = ctx('PostToolUse', say('hook.editReminder', { count: s.editsSincePlan, tool: planTool(), summary: core.summaryLine(agg) }));
  }
  core.saveSession(s);
  return reply;
}

// Rules still written into AGENTS.md / CLAUDE.md by an older install make the injected copy redundant.
function rulesAlreadyInstalled() {
  const file = AGENT === 'codex' ? path.join(os.homedir(), '.codex', 'AGENTS.md') : path.join(os.homedir(), '.claude', 'CLAUDE.md');
  try { return fs.readFileSync(file, 'utf8').includes('<!-- progress-hud:start -->'); } catch { return false; }
}

async function onSessionStart(ev, root) {
  try { (await import('./install.mjs')).writeHudShim(); } catch (e) { core.logError('hud-shim', e); }
  const rules = rulesAlreadyInstalled() ? '' : rulesText(AGENT);
  if (!hasProject(root)) return rules ? ctx('SessionStart', rules) : null;
  await ensureServer();
  const agg = core.aggregate(root, { withChecks: false });
  if (!agg.total) return rules ? ctx('SessionStart', rules) : null;
  const src = String(ev.source || '').toLowerCase();
  const long = src === 'compact' || src === 'resume' || src === 'clear';
  const head = agg.pct === 100 ? say('hook.prevDone') : `${say('hook.activePlan')}${long ? ' ' + t('hook.fullPlanFollows') : ''}`;
  const progress = `${head}\n${core.summaryLine(agg, { long })}`;
  return ctx('SessionStart', rules ? `${rules}\n\n${progress}` : progress, { systemMessage: t('hook.sessionBanner', { pct: agg.pct, url: core.dashboardUrl(root) }) });
}

async function onPrompt(ev, root) {
  if (!hasProject(root)) return null;
  const proj = core.readProject(root);
  const s = core.loadSession(root, AGENT, ev.session_id, proj?.epoch || 1);
  const prompt = String(ev.prompt || '');
  s.turnStartAt = core.now();
  s.editsThisTurn = 0;
  s.stopBlockedAt = null;
  if (PAUSE_RE.test(prompt)) s.paused = true;
  else if (RESUME_RE.test(prompt)) s.paused = false;
  core.saveSession(s);
  await ensureServer(); // server may have idled out while this session stayed open
  const agg = core.aggregate(root, { withChecks: false });
  if (!agg.total || agg.pct === 100) return null;
  const note = t(s.paused ? 'hook.pausedNote' : 'hook.keepUpdating');
  return ctx('UserPromptSubmit', say('hook.promptLine', { summary: core.summaryLine(agg), note }));
}

function onStop(ev, root) {
  if (!hasProject(root)) return null;
  if (ev.stop_hook_active) return null; // already blocked once this turn → let it end
  const proj = core.readProject(root);
  const s = core.loadSession(root, AGENT, ev.session_id, proj?.epoch || 1);
  if (s.paused || !s.versions?.length) return null;
  if (s.stopBlockedAt && s.turnStartAt && s.stopBlockedAt >= s.turnStartAt) return null; // once per turn
  const agg = core.aggregate(root, { withChecks: false });
  if (!agg.total || agg.pct === 100) return null;
  const editedThisTurn = (s.editsThisTurn || 0) > 0;
  const planUpdatedThisTurn = s.lastPlanAt && s.turnStartAt && s.lastPlanAt >= s.turnStartAt;
  if (!editedThisTurn || planUpdatedThisTurn) return null;
  s.stopBlockedAt = core.now();
  core.saveSession(s);
  return { decision: 'block', reason: say('hook.stopReason', { count: s.editsThisTurn, tool: planTool(), summary: core.summaryLine(agg) }) };
}

async function main() {
  const raw = readStdin();
  if (!raw.trim()) return;
  let ev;
  try { ev = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) { core.logError('parse-stdin', e); return; }
  const event = ev.hook_event_name || ev.hookEventName || '';
  const root = core.resolveProjectRoot(ev.cwd || process.cwd());
  core.heartbeat(AGENT, event, hasProject(root) ? root : null);

  let reply = null;
  if (event === 'PostToolUse' && PLAN_TOOLS.test(ev.tool_name || '')) reply = await onPlanTool(ev, root);
  else if (event === 'PostToolUse' && (EDIT_TOOLS.test(ev.tool_name || '') || SHELL_TOOLS.test(ev.tool_name || ''))) reply = onActivity(ev, root);
  else if (event === 'SessionStart') reply = await onSessionStart(ev, root);
  else if (event === 'UserPromptSubmit') reply = await onPrompt(ev, root);
  else if (event === 'Stop') reply = onStop(ev, root);
  out(reply);
}

main()
  .catch(e => core.logError(`hook:${AGENT}`, e))
  .finally(() => { clearTimeout(killer); process.exitCode = 0; });
