#!/usr/bin/env node
// progress <command>
//   status [dir]            Show progress as text
//   json [dir]              Full progress as JSON (used by the Claude side pane)
//   hud [dir]               {"label": ...} for the claude-hud --extra-cmd status line
//   serve                   Run the dashboard server in the foreground
//   open [dir]              Open the dashboard (starts the server if needed)
//   lang [auto|zh-TW|en]    Show or set the interface language
//   plan <set|start|done|todo|add|remove|show> …   Update progress without a to-do tool
//   statusline              Add progress to the claude-hud status line (optional)
//   install                 Local-clone install: Codex hooks + Claude plugin folder (backs up first)
//   uninstall               Remove everything install added
//   doctor                  Check the installation
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../lib/core.mjs';
import { t, getLang, setLang, configuredLang, bundle } from '../lib/i18n.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [cmd = 'status', arg] = process.argv.slice(2);

function alive() {
  return new Promise(r => {
    const q = http.get({ host: '127.0.0.1', port: core.PORT, path: '/health', timeout: 500 }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => r(b.includes('progress-hud')));
    });
    q.on('error', () => r(false)); q.on('timeout', () => { q.destroy(); r(false); });
  });
}

async function startServer() {
  if (await alive()) return true;
  spawn(process.execPath, [path.join(HERE, 'server.mjs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 150)); if (await alive()) return true; }
  return false;
}

const rootOf = d => core.resolveProjectRoot(d || process.cwd());

async function main() {
  switch (cmd) {
    case 'status': {
      const root = rootOf(arg);
      const agg = core.aggregate(root);
      if (!agg.total) { console.log(t('cli.noData', { root })); return; }
      console.log(`${agg.name}  ${agg.pct}%  (${agg.done}/${agg.total})`);
      console.log(core.summaryLine(agg, { long: true }).split('\n').slice(1).join('\n'));
      for (const w of agg.warnings) console.log(`! ${w.text}`);
      console.log(core.dashboardUrl(root));
      return;
    }
    case 'json': {
      const lang = getLang();
      process.stdout.write(JSON.stringify({ ...core.aggregate(rootOf(arg)), lang, strings: bundle('pane', lang) }));
      return;
    }
    case 'hud': {
      // label for claude-hud --extra-cmd (max ~50 chars), followed by the extra-cmd it replaced
      let label = '';
      try {
        const root = rootOf(arg);
        if (fs.existsSync(path.join(core.progressDir(root), 'project.json'))) {
          const agg = core.aggregate(root, { withChecks: false });
          if (agg.total) {
            const cur = agg.current[0];
            const feat = cur && agg.tree.find(f => f.id === String(cur.key).split('.')[0]);
            label = t('cli.hudLabel', { pct: agg.pct }) + (feat ? ` | ${feat.id} ${feat.pct}%` : '') + (cur ? ` | ▸${cur.key}` : '') + (agg.stale ? ' ⚠' : '');
          }
        }
      } catch { /* never break the status line */ }
      let chained = '';
      const chain = core.readJson(path.join(core.HOME_DIR, 'config.json'), {})?.chainExtraCmd;
      if (chain) {
        try { chained = JSON.parse(execSync(`"${chain}"`, { encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).label || ''; } catch { /* ignore */ }
      }
      let out = [label, chained].filter(Boolean).join('  ');
      if (out.length > 50) out = label || chained.slice(0, 50);
      process.stdout.write(JSON.stringify({ label: out }));
      return;
    }
    case 'serve':
      await import('./server.mjs');
      return;
    case 'open': {
      const root = rootOf(arg);
      if (!(await startServer())) { console.error(t('cli.serverFailed', { log: core.LOG_FILE })); process.exit(1); }
      const url = fs.existsSync(path.join(core.progressDir(root), 'project.json')) ? core.dashboardUrl(root) : `http://127.0.0.1:${core.PORT}/`;
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      console.log(url);
      return;
    }
    case 'plan': {
      const { runPlan } = await import('./plan.mjs');
      process.exitCode = await runPlan(process.argv.slice(3), { startServer });
      return;
    }
    case 'lang': {
      if (arg) {
        setLang(arg);
        console.log(t('cli.langSet', { lang: getLang() }));
      } else {
        console.log(t('cli.langNow', { lang: getLang(), setting: configuredLang() }));
      }
      return;
    }
    case 'install':
    case 'statusline':
    case 'uninstall':
    case 'doctor': {
      const mod = await import('./install.mjs');
      await mod[cmd]();
      return;
    }
    default:
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
