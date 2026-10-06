// install / statusline / uninstall / lang against a throwaway home folder.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(APP, 'bin', 'progress.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'phud-home-'));
const LAD = path.join(HOME, 'lad');
const HUD_CMD = path.join(LAD, 'progress-hud', 'hud-extra.cmd');
const env = { ...process.env, USERPROFILE: HOME, HOME, LOCALAPPDATA: LAD };
const settingsFile = path.join(HOME, '.claude', 'settings.json');
const codexHooks = path.join(HOME, '.codex', 'hooks.json');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`); }
};

const HUD = 'bash -c \'exec node "$HOME/.claude/plugins/cache/claude-hud/claude-hud/1.0/dist/index.js"';
const OTHER_STOP = { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] };

function fresh(settings, files = {}) {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(HOME, f)), { recursive: true }); fs.writeFileSync(path.join(HOME, f), body); }
}

function scenario(title, statusCommand) {
  console.log(title);
  const original = { env: { FOO: '1' }, hooks: OTHER_STOP, ...(statusCommand ? { statusLine: { type: 'command', command: statusCommand } } : {}) };
  fresh(original, { '.claude/CLAUDE.md': '# my rules\n' });

  check('install exits 0', run('install').status === 0);
  const s = read(settingsFile);
  check('Claude: plugin folder registered, own hooks/env kept', s.env.FOO === '1' && s.env.CLAUDE_CODE_PLUGIN_DIRS === APP && JSON.stringify(s.hooks) === JSON.stringify(OTHER_STOP), s);
  check('Codex: 4 hook events point at bin/hook.mjs', Object.keys(read(codexHooks).hooks).length === 4 && JSON.stringify(read(codexHooks)).includes('bin/hook.mjs codex'));
  check('rule files untouched', fs.readFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), 'utf8') === '# my rules\n' && !fs.existsSync(path.join(HOME, '.codex', 'AGENTS.md')));
  check('status line launcher written', fs.existsSync(HUD_CMD) && fs.readFileSync(HUD_CMD, 'utf8').includes(path.join(APP, 'bin', 'progress.mjs')));
  check('second install is idempotent', run('install').status === 0 && read(settingsFile).env.CLAUDE_CODE_PLUGIN_DIRS === APP && read(codexHooks).hooks.Stop.length === 1);
  const afterInstall = read(settingsFile).statusLine?.command;

  check('uninstall exits 0', run('uninstall').status === 0);
  const u = read(settingsFile);
  check('uninstall restores settings', JSON.stringify(u.hooks) === JSON.stringify(OTHER_STOP) && JSON.stringify(u.env) === JSON.stringify(original.env), u);
  check('uninstall restores the status line', (u.statusLine?.command ?? null) === (statusCommand ?? null), u.statusLine?.command);
  check('uninstall clears Codex hooks', Object.keys(read(codexHooks).hooks || {}).length === 0);
  return afterInstall;
}

let cmd = scenario('claude-hud with an existing --extra-cmd', `${HUD} --extra-cmd "C:\\x\\mine.cmd"'`);
check('existing extra-cmd chained behind ours', cmd.includes(`--extra-cmd "${HUD_CMD}"`) && read(path.join(LAD, 'progress-hud', 'config.json')).chainExtraCmd === 'C:\\x\\mine.cmd', cmd);

cmd = scenario('claude-hud without --extra-cmd', `${HUD}'`);
check('extra-cmd added', cmd.includes(`dist/index.js" --extra-cmd "${HUD_CMD}"`), cmd);

cmd = scenario('no status line at all', null);
check('status line left alone', cmd === undefined);

console.log('statusline only (marketplace installs)');
fresh({ statusLine: { type: 'command', command: `${HUD}'` } });
check('statusline exits 0', run('statusline').status === 0);
check('statusline adds the launcher and nothing else', read(settingsFile).statusLine.command.includes(HUD_CMD) && !read(settingsFile).env && !fs.existsSync(codexHooks));

console.log('migration from the version that edited rule files and settings hooks');
const OLD_HOOK = { type: 'command', command: 'node C:/old/progress-hud/bin/hook.mjs claude', timeout: 15 };
fresh({
  env: { CLAUDE_CODE_PLUGIN_DIRS: 'C:\\old\\progress-hud\\claude-plugin' },
  hooks: { ...OTHER_STOP, SessionStart: [{ hooks: [OLD_HOOK] }], UserPromptSubmit: [{ hooks: [OLD_HOOK] }] },
  statusLine: { type: 'command', command: `${HUD} --extra-cmd "C:\\old\\progress-hud\\bin\\hud-extra.cmd"'` },
}, {
  '.claude/CLAUDE.md': '# mine\n\n<!-- progress-hud:start -->\nold\n<!-- progress-hud:end -->\n',
  '.codex/AGENTS.md': '# codex\n\n<!-- progress-hud:start -->\nold\n<!-- progress-hud:end -->\n',
});
run('install');
const m = read(settingsFile);
check('old settings hooks removed, others kept', JSON.stringify(m.hooks) === JSON.stringify(OTHER_STOP), m.hooks);
check('old plugin folder replaced', m.env.CLAUDE_CODE_PLUGIN_DIRS === APP, m.env);
check('old launcher replaced by the stable one', m.statusLine.command.includes(`--extra-cmd "${HUD_CMD}"`) && !m.statusLine.command.includes('C:\\old'), m.statusLine.command);
check('old rule blocks removed', !fs.readFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), 'utf8').includes('progress-hud') && fs.readFileSync(path.join(HOME, '.codex', 'AGENTS.md'), 'utf8').startsWith('# codex'));

console.log('progress lang');
const lang = (...a) => run('lang', ...a);
check('lang en stored', lang('en').status === 0 && read(path.join(LAD, 'progress-hud', 'config.json')).lang === 'en');
check('output follows the setting', /Language set to en/.test(lang('en').stdout) && /語言已設為 zh-TW/.test(lang('zh-TW').stdout));
check('unsupported language is refused', lang('fr').status !== 0);
check('lang auto accepted', lang('auto').status === 0 && read(path.join(LAD, 'progress-hud', 'config.json')).lang === 'auto');

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
