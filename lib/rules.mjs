// The to-do list rules the agent needs, injected by the SessionStart hook.
import { t } from './i18n.mjs';
import { PORT } from './core.mjs';

export function rulesText(agent, lang) {
  const r = k => t('rules.' + k, undefined, lang);
  return [
    r('title'),
    '',
    t('rules.start', { tool: r(agent === 'codex' ? 'toolCodex' : 'toolClaude') }, lang),
    ...(agent === 'claude' ? [r('planMode')] : []),
    r('format'), r('numbering'), r('status'), r('extras'), r('small'),
    t('rules.url', { url: `http://127.0.0.1:${PORT}` }, lang),
  ].join('\n');
}
