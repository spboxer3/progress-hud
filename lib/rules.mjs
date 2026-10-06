// The to-do list rules the agent needs, injected by the SessionStart hook.
import { t } from './i18n.mjs';
import { PORT } from './core.mjs';

// cli: absolute path of bin/progress.mjs; session: the agent's session id, so CLI updates land in the same session.
export function rulesText(agent, lang, { cli, session } = {}) {
  const r = k => t('rules.' + k, undefined, lang);
  return [
    r('title'),
    '',
    t('rules.start', { tool: r(agent === 'codex' ? 'toolCodex' : 'toolClaude') }, lang),
    ...(agent === 'claude' ? [r('planMode')] : []),
    r('format'), r('numbering'), r('status'), r('extras'), r('small'),
    ...(cli ? cliLines(agent, lang, cli, session) : []),
    t('rules.url', { url: `http://127.0.0.1:${PORT}` }, lang),
  ].join('\n');
}

function cliLines(agent, lang, cli, session) {
  const cmd = `node "${cli}" plan --agent ${agent}${session ? ` --session ${session}` : ''}`;
  const tool = agent === 'codex' ? 'update_plan' : 'TodoWrite / TaskCreate';
  return [t('rules.cliTitle', { tool }, lang), t('rules.cliSet', { cmd }, lang), t('rules.cliStep', { cmd }, lang)];
}
