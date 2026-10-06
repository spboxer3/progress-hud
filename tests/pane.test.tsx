import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'progress-hud',
  props: { title: '專案進度', isFocused: false, bodyColumns: 60, placement: 'dock' },
  viewport: { columns: 60, rows: 30 },
} as const

test('pane shows the empty state on every surface before any plan exists', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'progress-hud', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /No progress data yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/progress opens the pane and explains what to do when there is no plan', async $ => {
  const { text } = await $.command.run({ command: 'progress', args: '' })
  expect(text).toContain('no progress yet')
})

