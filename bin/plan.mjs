// `progress plan …`: update progress from the shell, for agents that have no to-do tool
// (for example Codex sessions without update_plan). Writes into the same session file the
// hooks use when --agent/--session are given, so reminders and the Stop check see the update.
//
//   plan set "F1 Feature › F1.1 Step" "[~] F1 Feature › F1.2 Step" "[x] …"   whole plan
//   plan start F1.2 [F1.3 …]      mark in progress
//   plan done F1.1 [F1.2 …]       mark completed
//   plan todo F1.3                mark pending again
//   plan add "F1 Feature › F1.4 Step" […]
//   plan remove F1.4
//   plan show
// Options: --agent codex|claude (default cli)  --session <id>  --dir <project folder>
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../lib/core.mjs';
import { t } from '../lib/i18n.mjs';

const MARK = /^\s*\[( |x|X|~|-)\]\s*/;
const STATUS_OF = { ' ': 'pending', x: 'completed', X: 'completed', '~': 'in_progress', '-': 'in_progress' };

function parseArgs(argv) {
  const opts = { agent: 'cli', session: 'manual', dir: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') opts.agent = String(argv[++i] || 'cli').toLowerCase();
    else if (a === '--session') opts.session = String(argv[++i] || 'manual');
    else if (a === '--dir') opts.dir = argv[++i];
    else rest.push(a);
  }
  return { opts, action: (rest.shift() || 'show').toLowerCase(), args: rest };
}

const stepFrom = text => {
  const m = String(text).match(MARK);
  return { text: m ? String(text).slice(m[0].length) : String(text), status: m ? STATUS_OF[m[1]] : 'pending' };
};

function printPlan(s) {
  const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
  const steps = core.currentSteps(s);
  if (!steps.length) { console.log(t('cli.planEmpty')); return; }
  for (const st of steps) console.log(`${mark[st.status] || '[ ]'} ${st.text}`);
}

export async function runPlan(argv, { startServer } = {}) {
  const { opts, action, args } = parseArgs(argv);
  const root = core.resolveProjectRoot(opts.dir || process.cwd());
  const hasProject = fs.existsSync(path.join(core.progressDir(root), 'project.json'));
  const epoch = () => core.readProject(root)?.epoch || 1;

  if (action === 'show') {
    if (!hasProject) { console.log(t('cli.noData', { root })); return 0; }
    printPlan(core.loadSession(root, opts.agent, opts.session, epoch()));
    return 0;
  }

  let steps;
  if (action === 'set') {
    if (!args.length) { console.error(t('cli.planUsage')); return 2; }
    steps = args.map(stepFrom);
    if (hasProject) core.maybeStartMilestone(root, steps);
  } else if (['start', 'done', 'todo', 'add', 'remove'].includes(action)) {
    if (!args.length) { console.error(t('cli.planUsage')); return 2; }
    const current = hasProject ? core.currentSteps(core.loadSession(root, opts.agent, opts.session, epoch())) : [];
    if (action === 'add') {
      if (!current.length && hasProject) core.maybeStartMilestone(root, args.map(stepFrom));
      steps = [...current, ...args.map(stepFrom)];
    } else {
      const ids = new Set(args.map(a => a.replace(/^\[|\]$/g, '')));
      const missing = [...ids].filter(id => !current.some(st => st.id === id));
      if (missing.length) { console.error(t('cli.planUnknown', { ids: missing.join(', ') })); return 2; }
      const to = { start: 'in_progress', done: 'completed', todo: 'pending' }[action];
      steps = current
        .filter(st => !(action === 'remove' && ids.has(st.id)))
        .map(st => (to && ids.has(st.id) ? { ...st, status: to } : st));
    }
  } else {
    console.error(t('cli.planUsage'));
    return 2;
  }

  const firstTime = !hasProject;
  const proj = core.ensureProject(root);
  const s = core.loadSession(root, opts.agent, opts.session, proj.epoch || 1);
  const result = core.applyPlan(s, steps.map(({ text, status }) => ({ text, status })), { full: true, reason: action === 'set' ? 'update' : 'cli' });
  s.paused = false;
  s.planSource = 'cli';
  s.raw = [...(s.raw || []), { at: core.now(), tool: 'cli', input: { action, args } }].slice(-5);
  core.saveSession(s);
  core.recordPlanEvent(opts.agent, 'cli', root);

  if (startServer) await startServer();
  const agg = core.aggregate(root, { withChecks: false });
  printPlan(s);
  console.log(core.summaryLine(agg));
  if (result.unformatted.length) console.log(t('cli.planUnformatted', { steps: result.unformatted.join(' / ') }));
  if (result.replanned) console.log(t('hook.replanned'));
  console.log((firstTime ? t('hook.started', { url: core.dashboardUrl(root) }) : core.dashboardUrl(root)));
  return 0;
}
