export type Strings = Record<string, string>

export type Row = {
  depth: number
  icon: string
  label: string
  pct?: number
  tone: 'done' | 'doing' | 'todo' | 'gone' | 'bad' | 'feature'
  tag?: string
}

export type Snapshot = {
  name: string
  url: string
  pct: number
  done: number
  total: number
  stale: boolean
  paused: boolean
  lastPlanAt: string | null
  warnings: string[]
  current: string[]
  next: string | null
  rows: Row[]
}

declare module 'claude-code' {
  interface PluginState {
    'progress-hud': { snap: Snapshot | null; strings: Strings | null; opened: boolean }
  }
}
