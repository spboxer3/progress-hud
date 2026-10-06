import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Row, Snapshot, Strings } from '../types'

const PANE = 'progress-hud'
const REFRESH_MS = 4000

// Shown only until the CLI answers (or where it cannot run); every other string comes from lib/i18n.mjs.
const FALLBACK: Strings = {
  title: 'Project progress',
  command: 'Open the project progress side pane (project / features / steps)',
  emptyTitle: 'Project progress',
  emptyBody: 'No progress data yet.',
  emptyHint: 'This fills in once the AI creates a to-do list like "F1 Feature › F1.1 Step".',
  cmdNone: 'This project has no progress yet. It appears once the AI creates a to-do list (F1 Feature › F1.1 Step).',
}

const snap = atom({ plugin: 'progress-hud', key: 'snap' } as const, null as Snapshot | null)
const strings = atom({ plugin: 'progress-hud', key: 'strings' } as const, null as Strings | null)
const opened = atom({ plugin: 'progress-hud', key: 'opened' } as const, false)

const tr = (s: Strings | null, key: string, vars?: Record<string, string | number>) =>
  String(s?.[key] ?? FALLBACK[key] ?? key).replace(/\{(\w+)\}/g, (m, k: string) => (vars && vars[k] !== undefined ? String(vars[k]) : m))

type Node = {
  key: string
  id: string
  name: string
  status: string
  pct?: number
  missing?: boolean
  isFeature?: boolean
  verified?: string
  workers?: string[]
  children?: Node[]
  subagents?: { agentType: string; items: { name: string; status: string }[] }[]
}

const icon = (n: Node) =>
  n.missing || n.status === 'deleted' ? '–' : n.status === 'done' ? '✓' : n.status === 'doing' ? '▸' : '○'

const label = (key: string, name: string) => (key.startsWith('U-') ? name : `${key} ${name}`)

function flatten(tree: Node[], s: Strings): Row[] {
  const rows: Row[] = []
  const walk = (n: Node, depth: number) => {
    const kids = n.children ?? []
    let tone: Row['tone'] = n.missing || n.status === 'deleted' ? 'gone' : (n.status as Row['tone'])
    let tag: string | undefined
    if (n.status === 'done' && n.verified === 'fail') { tone = 'bad'; tag = tr(s, 'tagFailed') }
    else if (n.status === 'done' && n.verified === 'pass') tag = tr(s, 'tagVerified')
    else if (n.status === 'doing' && n.workers?.length) tag = n.workers.map(w => w.split('·')[0]).join(tr(s, 'workerSep'))
    else if (n.missing) tag = tr(s, 'tagMissing')
    rows.push({
      depth,
      icon: n.isFeature ? '■' : icon(n),
      label: n.isFeature ? (n.id === 'U' ? n.name : `${n.id} ${n.name}`) : label(n.key, n.name),
      pct: kids.length || n.isFeature ? n.pct : undefined,
      tone: n.isFeature ? 'feature' : tone,
      tag,
    })
    for (const sub of n.subagents ?? []) {
      for (const it of sub.items) {
        rows.push({
          depth: depth + 1,
          icon: it.status === 'done' ? '✓' : it.status === 'doing' ? '▸' : '○',
          label: `${tr(s, 'subagent', { type: sub.agentType })}${it.name}`,
          tone: it.status === 'done' ? 'done' : 'todo',
        })
      }
    }
    kids.forEach(c => walk(c, depth + 1))
  }
  tree.forEach(f => walk(f, 0))
  return rows
}

const bar = (pct: number, width = 16) => {
  const fill = Math.round((pct / 100) * width)
  return '█'.repeat(fill) + '░'.repeat(width - fill)
}

const ago = (s: Strings | null, iso: string | null) => {
  if (!iso) return tr(s, 'agoNever')
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return m < 1 ? tr(s, 'agoNow') : m < 60 ? tr(s, 'agoMin', { n: m }) : tr(s, 'agoHour', { n: Math.round(m / 60) })
}

const TONE: Record<Row['tone'], { color?: string; dim?: boolean; bold?: boolean; strike?: boolean }> = {
  feature: { bold: true },
  done: { color: 'green', dim: true },
  doing: { color: 'cyan', bold: true },
  todo: {},
  gone: { dim: true, strike: true },
  bad: { color: 'red' },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const cli = `${$.plugin.root}/bin/progress.mjs`

    const refresh = async () => {
      try {
        const cwd = await $.session.cwd()
        const r = await $.process.run(['node', cli, 'json', cwd], { timeoutMs: 10000 })
        if (r.exitCode !== 0) return
        const a = JSON.parse(r.stdout)
        const s: Strings = a.strings ?? {}
        await update($, strings, () => s)
        const latest: Snapshot | null = a.total
          ? {
              name: a.name,
              url: `http://127.0.0.1:7788/?p=${a.id}`,
              pct: a.pct,
              done: a.done,
              total: a.total,
              stale: !!a.stale,
              paused: !!a.paused,
              lastPlanAt: a.lastPlanAt ?? null,
              warnings: (a.warnings ?? []).map((w: { text: string }) => w.text),
              current: (a.current ?? []).map((c: { key: string; name: string }) => label(c.key, c.name)),
              next: a.next ? label(a.next.key, a.next.name) : null,
              rows: flatten(a.tree ?? [], s),
            }
          : null
        await update($, snap, () => latest)
        if (latest && !(await read($, opened))) {
          await update($, opened, () => true)
          void $.ui.open({ id: PANE, title: tr(s, 'title') })
        }
      } catch {
        // a failed refresh keeps the last snapshot
      }
    }

    await refresh()
    await $.command.register({ name: 'progress', description: tr(await read($, strings), 'command') })
    $.clock.every(REFRESH_MS, () => { void refresh() })
    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const st = await read($, strings)
    // /progress status | doctor | statusline | lang [auto|en|zh-TW] → the CLI; no arguments → open the pane
    const args = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (args.length) {
      if (!/^(status|doctor|statusline|lang)$/i.test(args[0] ?? '')) return { text: '/progress [status | doctor | statusline | lang auto|en|zh-TW]' }
      const extra = args[0] === 'status' ? [await $.session.cwd()] : []
      const r = await $.process.run(['node', `${$.plugin.root}/bin/progress.mjs`, ...args.slice(0, 2), ...extra], { timeoutMs: 20000 })
      return { text: (r.stdout || r.stderr).trim() }
    }
    await update($, opened, () => true)
    try { await $.ui.open({ id: PANE, title: tr(st, 'title') }) } catch { /* surface without panes */ }
    const s = await read($, snap)
    return { text: s ? tr(st, 'cmdHas', { pct: s.pct, done: s.done, total: s.total, url: s.url }) : tr(st, 'cmdNone') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const st = await read($, strings)
    const s = await read($, snap)
    if (!s) {
      return (
        <Box flexDirection="column">
          <Text bold>{tr(st, 'emptyTitle')}</Text>
          <Text dimColor>{tr(st, 'emptyBody')}</Text>
          <Text dimColor>{tr(st, 'emptyHint')}</Text>
        </Box>
      )
    }
    const room = Math.max(4, (e.viewport?.rows ?? 30) - 9 - s.warnings.length)
    const shown = s.rows.slice(0, room)
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">{s.name}</Text>
        <Text>
          <Text color="green">{bar(s.pct)}</Text>
          <Text bold> {s.pct}%</Text>
          <Text dimColor> {s.done}/{s.total}{s.paused ? tr(st, 'paused') : ''}</Text>
        </Text>
        <Text color={s.stale ? 'yellow' : undefined} dimColor={!s.stale}>
          {s.stale ? '⚠ ' : '● '}{tr(st, 'updated', { ago: ago(st, s.lastPlanAt) })}
        </Text>
        {s.warnings.map(w => <Text color="yellow" wrap="wrap">! {w}</Text>)}
        <Text wrap="truncate-end"><Text dimColor>{tr(st, 'current')}</Text>{s.current.join(tr(st, 'workerSep')) || tr(st, 'none')}</Text>
        <Text wrap="truncate-end"><Text dimColor>{tr(st, 'next')}</Text>{s.next ?? tr(st, 'none')}</Text>
        <Text> </Text>
        {shown.map(r => {
          const t = TONE[r.tone]
          return (
            <Text wrap="truncate-end">
              {'  '.repeat(r.depth)}
              <Text color={t.color} dimColor={!!t.dim} bold={!!t.bold} strikethrough={!!t.strike}>{r.icon} {r.label}</Text>
              {r.pct !== undefined ? <Text dimColor> {r.pct}%</Text> : null}
              {r.tag ? <Text color="cyan" dimColor> [{r.tag}]</Text> : null}
            </Text>
          )
        })}
        {s.rows.length > shown.length ? <Text dimColor>{tr(st, 'more', { n: s.rows.length - shown.length })}</Text> : null}
        <Text dimColor wrap="truncate-end">{s.url}</Text>
      </Box>
    )
  })
}
