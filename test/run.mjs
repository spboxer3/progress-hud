// End-to-end tests: feed real-shaped hook payloads to bin/hook.mjs and check the stored progress.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'bin', 'hook.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phud-test-'));
const LOCAL = path.join(TMP, 'localappdata');
const PROJ = path.join(TMP, '中文 專案 dir');
fs.mkdirSync(PROJ, { recursive: true });
process.env.LOCALAPPDATA = LOCAL;
process.env.PROGRESS_HUD_LANG = 'zh-TW'; // assertions below match the Traditional Chinese strings
const core = await import('../lib/core.mjs');
const i18n = await import('../lib/i18n.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : ''}`); }
}

function hook(agent, payload, raw) {
  const r = spawnSync(process.execPath, [HOOK, agent], {
    input: raw ?? JSON.stringify({ cwd: PROJ, session_id: 's1', ...payload }),
    env: { ...process.env, LOCALAPPDATA: LOCAL, USERPROFILE: TMP, HOME: TMP, PROGRESS_HUD_NO_SERVER: '1' }, encoding: 'utf8',
  });
  let out = null;
  try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch { out = { _raw: r.stdout }; }
  return { code: r.status, out, err: r.stderr };
}
const plan = (steps, extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'update_plan', tool_input: { plan: steps.map(([step, status]) => ({ step, status })) }, ...extra });
const agg = () => core.aggregate(PROJ);
const find = (a, key) => { let hit; const w = n => { if (n.key === key) hit = n; (n.children || []).forEach(w); }; a.tree.forEach(w); return hit; };

console.log('Codex: first plan creates the project');
let r = hook('codex', plan([
  ['F1 產品頁模板 › F1.1 規格表元件 [check: file src/spec.js]', 'completed'],
  ['F1 產品頁模板 › F1.2 tab 切換', 'in_progress'],
  ['F2 SEO › F2.1 meta 標籤 [check: grep index.html "og:description"]', 'pending'],
  ['F2 SEO › F2.2 sitemap', 'pending'],
]));
check('hook exits 0', r.code === 0, r.err);
check('first plan announces the dashboard URL', /127\.0\.0\.1:7788\/\?p=/.test(r.out?.systemMessage || ''), r.out);
check('.progress/.gitignore ignores everything', fs.readFileSync(path.join(PROJ, '.progress', '.gitignore'), 'utf8').includes('*'));
let a = agg();
check('4 steps, 1 done → 25%', a.total === 4 && a.done === 1 && a.pct === 25, { total: a.total, done: a.done, pct: a.pct });
check('two features with names', a.tree.length === 2 && a.tree[0].name === '產品頁模板' && a.tree[1].name === 'SEO', a.tree.map(f => f.name));
check('feature F1 at 50%', a.tree[0].pct === 50);
check('current = F1.2, next = F2.1', a.current[0]?.key === 'F1.2' && a.next?.key === 'F2.1', { current: a.current, next: a.next });
check('done without file evidence → verify fail', find(a, 'F1.1').verified === 'fail');
fs.mkdirSync(path.join(PROJ, 'src')); fs.writeFileSync(path.join(PROJ, 'src', 'spec.js'), '//');
check('file now exists → verified pass', find(agg(), 'F1.1').verified === 'pass');
check('check outside the project is refused', core.runCheck(PROJ, 'file ../../etc/passwd').ok === false && /拒絕/.test(core.runCheck(PROJ, 'file ../../x').detail));

console.log('Codex: partial list keeps missing items');
r = hook('codex', plan([['F1 產品頁模板 › F1.2 tab 切換', 'completed'], ['F2 SEO › F2.1 meta 標籤', 'in_progress'], ['F2 SEO › F2.2 sitemap', 'pending']]));
a = agg();
check('F1.1 kept as done but marked missing', find(a, 'F1.1').status === 'done' && find(a, 'F1.1').missing === true);
check('missing items are not counted', a.total === 3 && a.done === 1, { total: a.total, done: a.done });

console.log('Codex: unformatted steps → 未分類 + nag');
r = hook('codex', plan([['F1 產品頁模板 › F1.2 tab 切換', 'completed'], ['F2 SEO › F2.1 meta 標籤', 'in_progress'], ['F2 SEO › F2.2 sitemap', 'pending'], ['順手修一下 footer', 'pending']]));
a = agg();
check('unformatted step lands in 未分類', a.tree.some(f => f.id === 'U' && f.name === '未分類'));
check('AI is asked to fix the format', /F<n> 功能名/.test(r.out?.hookSpecificOutput?.additionalContext || ''), r.out);

console.log('Edits without plan updates → reminder, Stop blocks once');
hook('codex', { hook_event_name: 'UserPromptSubmit', prompt: '繼續做' });
let last;
for (let i = 0; i < 8; i++) last = hook('codex', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch' } });
check('8th edit reminds the AI', /修改了 8 次檔案/.test(last.out?.hookSpecificOutput?.additionalContext || ''), last.out);
r = hook('codex', { hook_event_name: 'Stop', stop_hook_active: false });
check('Stop blocks when files changed but plan did not', r.out?.decision === 'block', r.out);
r = hook('codex', { hook_event_name: 'Stop', stop_hook_active: true });
check('second Stop in the same turn is allowed', r.out === null, r.out);
r = hook('codex', { hook_event_name: 'Stop', stop_hook_active: false });
check('no repeat block within the same turn', r.out === null, r.out);
const ro = hook('codex', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } });
check('read-only shell commands are not counted', ro.out === null);

console.log('Pause');
hook('codex', { hook_event_name: 'UserPromptSubmit', prompt: '先暫停，明天再做' });
hook('codex', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: {} });
r = hook('codex', { hook_event_name: 'Stop', stop_hook_active: false });
check('paused session is never blocked', r.out === null, r.out);
check('aggregate shows paused', agg().paused === true);
r = hook('codex', { hook_event_name: 'UserPromptSubmit', prompt: '繼續' });
check('prompt injection carries progress summary', /總進度/.test(r.out?.hookSpecificOutput?.additionalContext || ''), r.out);

console.log('Subagent plan nests under the in-progress item');
hook('codex', plan([['寫測試', 'completed'], ['跑 lint', 'in_progress']], { agent_id: 'sub-1', agent_type: 'worker' }));
a = agg();
check('subagent steps hang under F2.1', (find(a, 'F2.1').subagents || [])[0]?.items.length === 2, find(a, 'F2.1'));
check('subagent did not replace the main plan', a.total >= 3 && find(a, 'F2.2'));

console.log('Concurrent Claude session on the same project');
r = hook('claude', { session_id: 'c1', hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos: [
  { content: 'F2 SEO › F2.2 sitemap', status: 'in_progress', activeForm: 'x' },
] } });
a = agg();
check('Claude update merges into the same tree', find(a, 'F2.2').status === 'doing' && /claude/.test(find(a, 'F2.2').by), find(a, 'F2.2'));
check('two agents listed as sessions', new Set(a.sessions.map(s => s.agent)).size === 2);

console.log('Replan → new version');
r = hook('codex', plan([['F3 改用新架構 › F3.1 拆元件', 'in_progress'], ['F3 改用新架構 › F3.2 改路由', 'pending'], ['F3 改用新架構 › F3.3 驗收', 'pending']]));
const sess = core.aggregate(PROJ).sessions.find(s => s.agent === 'codex');
check('codex session now has v2', sess.versions.length === 2 && sess.versions[1].reason === 'replan', sess.versions.map(v => v.reason));
check('replan is announced to the AI', /新版本/.test(r.out?.hookSpecificOutput?.additionalContext || ''), r.out);

console.log('Milestone: finished plan + unrelated new plan → new epoch');
hook('claude', { session_id: 'c1', hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'F2 SEO › F2.2 sitemap', status: 'completed', activeForm: 'x' }] } });
hook('codex', plan([['F3 改用新架構 › F3.1 拆元件', 'completed'], ['F3 改用新架構 › F3.2 改路由', 'completed'], ['F3 改用新架構 › F3.3 驗收', 'completed']]));
a = agg();
check('everything done → 100%', a.pct === 100, { pct: a.pct, total: a.total, done: a.done });
hook('codex', plan([['F1 首頁 SEO › F1.1 title', 'in_progress'], ['F1 首頁 SEO › F1.2 schema', 'pending']]));
a = agg();
check('epoch 2 started, milestone archived', a.epoch === 2 && a.milestones.length === 1, { epoch: a.epoch, ms: a.milestones });
check('new epoch only shows the new plan', a.total === 2 && a.tree[0].name === '首頁 SEO', a.tree.map(f => f.name));
check('milestone file written', fs.existsSync(path.join(PROJ, '.progress', 'milestones', 'epoch-1.json')));
hook('codex', plan([['F1 首頁 SEO › F1.1 title', 'completed'], ['F1 首頁 SEO › F1.2 schema', 'completed']]));
hook('codex', plan([['F1 首頁 SEO › F1.1 title', 'completed'], ['F1 首頁 SEO › F1.2 schema', 'completed']]));
check('re-sending a finished plan does not archive it', agg().epoch === 2);
hook('claude', { session_id: 'c9', hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos: [
  { content: 'F1 頁尾 › F1.1 加版權文字', status: 'in_progress', activeForm: 'x' },
  { content: 'F1 頁尾 › F1.2 驗證', status: 'pending', activeForm: 'x' },
] } });
a = agg();
check('a new task reusing F1 numbers starts a new milestone', a.epoch === 3 && a.total === 2 && a.tree[0].name === '頁尾', { epoch: a.epoch, total: a.total, names: a.tree.map(f => f.name) });
hook('claude', { session_id: 'c9', hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos: [
  { content: 'F1 頁尾 › F1.1 加版權文字', status: 'completed', activeForm: 'x' },
  { content: 'F1 頁尾 › F1.2 驗證', status: 'completed', activeForm: 'x' },
] } });
const taskCreate = (sid, id, subject) => hook('claude', { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_input: { subject, description: 'x' }, tool_response: { task: { id, subject } } });
taskCreate('c9', '1', 'F1 頁尾 › F1.3 補連結');
check('same session adding a task to a finished plan continues it', agg().epoch === 3 && agg().total === 3);
hook('claude', { session_id: 'c9', hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' } });
taskCreate('t2', '1', 'F1 表單 › F1.1 欄位驗證');
taskCreate('t2', '2', 'F1 表單 › F1.2 錯誤訊息');
a = agg();
check('a new session starting with TaskCreate starts a new milestone', a.epoch === 4 && a.total === 2 && a.tree[0].name === '表單', { epoch: a.epoch, total: a.total, names: a.tree.map(f => f.name) });

console.log('Claude: ExitPlanMode markdown, TaskCreate/TaskUpdate');
const P2 = path.join(TMP, 'claude proj');
fs.mkdirSync(P2);
const md = '# 計畫\n\n## F1 登入頁\n- [ ] F1.1 表單\n- [ ] F1.2 驗證\n\n## F2 文件\n- [x] F2.1 README\n';
r = hook('claude', null, JSON.stringify({ cwd: P2, session_id: 'k1', hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: md } }));
let b = core.aggregate(P2);
check('plan markdown → 3 items, 1 done', b.total === 3 && b.done === 1 && b.tree[0].name === '登入頁', { total: b.total, done: b.done, names: b.tree.map(f => f.name) });
hook('claude', null, JSON.stringify({ cwd: P2, session_id: 'k1', hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_input: { subject: 'F1 登入頁 › F1.3 錯誤訊息', description: 'x' }, tool_response: { task: { id: '7', subject: 'F1 登入頁 › F1.3 錯誤訊息' } } }));
hook('claude', null, JSON.stringify({ cwd: P2, session_id: 'k1', hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_input: { taskId: '7', status: 'completed' }, tool_response: { success: true } }));
b = core.aggregate(P2);
check('TaskCreate + TaskUpdate tracked by id', find(b, 'F1.3')?.status === 'done' && b.total === 4, find(b, 'F1.3'));
hook('claude', null, JSON.stringify({ cwd: P2, session_id: 'k1', hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_input: { taskId: '7', status: 'deleted' } }));
check('deleted task leaves the count', core.aggregate(P2).total === 3);
r = hook('claude', null, JSON.stringify({ cwd: P2, session_id: 'k2', hook_event_name: 'SessionStart', source: 'compact' }));
check('after compaction the full plan is re-injected', /F1\.2/.test(r.out?.hookSpecificOutput?.additionalContext || '') && /完整計畫/.test(r.out.hookSpecificOutput.additionalContext), r.out);

console.log('Robustness');
check('garbage stdin → exit 0, no output', (() => { const x = hook('codex', null, '{not json'); return x.code === 0 && x.out === null; })());
check('empty stdin → exit 0', hook('codex', null, '').code === 0);
const P3 = path.join(TMP, 'untouched');
fs.mkdirSync(P3);
hook('codex', null, JSON.stringify({ cwd: P3, session_id: 'z', hook_event_name: 'PostToolUse', tool_name: 'apply_patch' }));
hook('codex', null, JSON.stringify({ cwd: P3, session_id: 'z', hook_event_name: 'SessionStart', source: 'startup' }));
check('edits/sessions without a plan never create .progress', !fs.existsSync(path.join(P3, '.progress')));
r = hook('codex', null, JSON.stringify({ cwd: P3, session_id: 'z', hook_event_name: 'SessionStart', source: 'startup' }));
check('SessionStart injects the to-do rules even without a plan', /F<n> 功能名 › F<n>.<m> 細項/.test(r.out?.hookSpecificOutput?.additionalContext || '') && /update_plan/.test(r.out.hookSpecificOutput.additionalContext), r.out);
r = hook('claude', null, JSON.stringify({ cwd: P3, session_id: 'z', hook_event_name: 'SessionStart', source: 'startup' }));
check('Claude rules mention plan mode and TodoWrite', /plan mode/.test(r.out?.hookSpecificOutput?.additionalContext || '') && /TodoWrite/.test(r.out.hookSpecificOutput.additionalContext), r.out);
check('SessionStart refreshes the status line launcher', fs.readFileSync(path.join(LOCAL, 'progress-hud', 'hud-extra.cmd'), 'utf8').includes(path.join('bin', 'progress.mjs')));
fs.mkdirSync(path.join(TMP, '.codex'), { recursive: true });
fs.writeFileSync(path.join(TMP, '.codex', 'AGENTS.md'), '<!-- progress-hud:start -->\nold rules\n<!-- progress-hud:end -->\n');
r = hook('codex', null, JSON.stringify({ cwd: P3, session_id: 'z', hook_event_name: 'SessionStart', source: 'startup' }));
check('no duplicate rules when an older install already wrote them', r.out === null, r.out);
fs.rmSync(path.join(TMP, '.codex'), { recursive: true, force: true });
const sf = fs.readdirSync(path.join(P2, '.progress', 'sessions')).find(f => f.startsWith('claude-k1') && f.endsWith('.json'));
fs.writeFileSync(path.join(P2, '.progress', 'sessions', sf), '{corrupt');
check('corrupt session file recovers from the previous good copy', core.aggregate(P2).total >= 3);
check('\\\\?\\ and /c/ paths normalise', core.normPath('\\\\?\\C:\\Users\\x') === 'C:\\Users\\x' && core.normPath('/c/Users/x') === 'C:\\Users\\x');
check('parseStep variants', (() => {
  const a1 = core.parseStep('[F2.3] 寫文件'), a2 = core.parseStep('F1 首頁 > F1.1 header [w:3]'), a3 = core.parseStep('F4.1.2 細節');
  return a1.id === 'F2.3' && a1.featureId === 'F2' && a2.weight === 3 && a2.featureName === '首頁' && a3.featureId === 'F4';
})());
const reg = core.readRegistry();
check('heartbeat recorded for both agents', reg.heartbeat.codex && reg.heartbeat.claude);

console.log('progress plan (agents without a to-do tool)');
const CLI = path.join(HERE, '..', 'bin', 'progress.mjs');
const P5 = path.join(TMP, 'cli plan');
fs.mkdirSync(P5);
const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [CLI, 'plan', ...args, '--dir', P5], {
  env: { ...process.env, LOCALAPPDATA: LOCAL, USERPROFILE: TMP, HOME: TMP, PROGRESS_HUD_NO_SERVER: '1', PROGRESS_HUD_LANG: 'zh-TW', ...extraEnv }, encoding: 'utf8',
});
const S5 = ['--agent', 'codex', '--session', 's5'];
let c5 = cli(['set', ...S5, '[x] F1 登入 › F1.1 表單 [check: file login.html]', '[~] F1 登入 › F1.2 驗證', 'F2 文件 › F2.1 README [w:2]']);
let a5 = core.aggregate(P5);
check('plan set creates the project with statuses from [x] / [~]', c5.status === 0 && a5.total === 4 && a5.done === 1 && a5.current[0]?.key === 'F1.2', { code: c5.status, err: c5.stderr, total: a5.total, done: a5.done });
check('plan set prints the dashboard URL', /127\.0\.0\.1:7788\/\?p=/.test(c5.stdout));
c5 = cli(['done', ...S5, 'F1.2']); cli(['start', ...S5, 'F2.1']);
a5 = core.aggregate(P5);
check('plan done / start update one step each', c5.status === 0 && find(a5, 'F1.2').status === 'done' && find(a5, 'F2.1').status === 'doing');
check('marks survive edits ([check:] and [w:])', find(a5, 'F1.1').check === 'file login.html' && find(a5, 'F2.1').weight === 2, { f11: find(a5, 'F1.1'), f21: find(a5, 'F2.1') });
cli(['add', ...S5, 'F2 文件 › F2.2 CHANGELOG']);
check('plan add appends a pending step', find(core.aggregate(P5), 'F2.2')?.status === 'todo');
cli(['remove', ...S5, 'F2.2']);
check('plan remove drops the step from the count (F2.1 weighs 2)', core.aggregate(P5).total === 4 && find(core.aggregate(P5), 'F2.2').missing === true, core.aggregate(P5).total);
c5 = cli(['done', ...S5, 'F9.9']);
check('unknown step id is refused', c5.status === 2 && /F9\.9/.test(c5.stderr));
check('plan show lists the plan with marks', /\[x\] F1 登入 › F1\.1 表單/.test(cli(['show', ...S5]).stdout));
check('plan updates are recorded for doctor', core.readRegistry().planEvents?.codex?.source === 'cli');
const h5 = (payload) => spawnSync(process.execPath, [HOOK, 'codex'], {
  input: JSON.stringify({ cwd: P5, session_id: 's5', ...payload }),
  env: { ...process.env, LOCALAPPDATA: LOCAL, USERPROFILE: TMP, HOME: TMP, PROGRESS_HUD_NO_SERVER: '1' }, encoding: 'utf8',
});
h5({ hook_event_name: 'UserPromptSubmit', prompt: '繼續' });
h5({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: {} });
cli(['done', ...S5, 'F2.1']);
r = { out: h5({ hook_event_name: 'Stop', stop_hook_active: false }).stdout || null };
check('a CLI update in the same session satisfies the Stop check', r.out === null, r.out);
r = { out: JSON.parse(h5({ hook_event_name: 'SessionStart', source: 'startup' }).stdout || 'null') };
const rules5 = r.out?.hookSpecificOutput?.additionalContext || '';
check('rules include the ready-to-run plan command for this session', rules5.includes('progress.mjs" plan --agent codex --session s5 set') && rules5.includes('update_plan'), rules5.slice(0, 300));
// a sandboxed shell may not reach %LOCALAPPDATA%: the project then exists only in the project folder
const P6 = path.join(TMP, 'sandboxed');
fs.mkdirSync(P6);
spawnSync(process.execPath, [CLI, 'plan', 'set', 'F1 A › F1.1 B', '--dir', P6], { env: { ...process.env, LOCALAPPDATA: path.join(TMP, 'sandbox-lad'), PROGRESS_HUD_NO_SERVER: '1' }, encoding: 'utf8' });
check('sandboxed CLI run left the real registry untouched', !Object.values(core.readRegistry().projects || {}).some(p => p.root === core.normPath(P6)));
spawnSync(process.execPath, [HOOK, 'codex'], { input: JSON.stringify({ cwd: P6, session_id: 'x', hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_input: { cmd: 'ls' } }), env: { ...process.env, LOCALAPPDATA: LOCAL, USERPROFILE: TMP, HOME: TMP, PROGRESS_HUD_NO_SERVER: '1' }, encoding: 'utf8' });
check('the next hook event registers that project for the dashboard', Object.values(core.readRegistry().projects || {}).some(p => p.root === core.normPath(P6)));

console.log('Languages');
const P4 = path.join(TMP, 'english');
fs.mkdirSync(P4);
const en = (payload) => {
  const r = spawnSync(process.execPath, [HOOK, 'codex'], {
    input: JSON.stringify({ cwd: P4, session_id: 'e1', ...payload }),
    env: { ...process.env, LOCALAPPDATA: LOCAL, USERPROFILE: TMP, HOME: TMP, PROGRESS_HUD_NO_SERVER: '1', PROGRESS_HUD_LANG: 'en' }, encoding: 'utf8',
  });
  return r.stdout ? JSON.parse(r.stdout) : null;
};
r = { out: en(plan([['F1 Login › F1.1 Form', 'in_progress'], ['F1 Login › F1.2 Validation', 'pending'], ['tidy footer', 'pending']])) };
check('English: first-plan banner', /^Progress HUD started:/.test(r.out?.systemMessage || ''), r.out);
check('English: format reminder', /do not follow the format/.test(r.out?.hookSpecificOutput?.additionalContext || ''), r.out);
r = { out: en({ hook_event_name: 'UserPromptSubmit', prompt: 'continue' }) };
check('English: prompt summary', /^\[Progress HUD\] Progress 0% \(0\/3\)/.test(r.out?.hookSpecificOutput?.additionalContext || ''), r.out);
en({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: {} });
r = { out: en({ hook_event_name: 'Stop', stop_hook_active: false }) };
check('English: Stop reason', /did not update progress/.test(r.out?.reason || ''), r.out);
check('Uncategorized label follows the language', i18n.t('core.uncategorized', null, 'en') === 'Uncategorized' && core.aggregate(P4).tree.some(f => f.id === 'U' && f.name === '未分類'));
check('normLang maps variants', i18n.normLang('zh_Hant_TW') === 'zh-TW' && i18n.normLang('zh-CN') === 'zh-TW' && i18n.normLang('en-GB') === 'en' && i18n.normLang('auto') === null && i18n.normLang('fr') === null);
const keysOf = l => Object.entries(i18n.STRINGS[l]).flatMap(([ns, o]) => Object.keys(o).map(k => `${ns}.${k}`)).sort();
const zhKeys = keysOf('zh-TW'), enKeys = keysOf('en');
check('both languages define the same keys', JSON.stringify(zhKeys) === JSON.stringify(enKeys), zhKeys.filter(k => !enKeys.includes(k)).concat(enKeys.filter(k => !zhKeys.includes(k))));

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
