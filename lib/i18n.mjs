// UI language for every surface: hooks, CLI, installer rules, dashboard and Claude pane.
// Choice order: PROGRESS_HUD_LANG env → config.json "lang" → system locale (zh* → zh-TW, else en).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const LANGS = ['zh-TW', 'en'];
const CONFIG = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'progress-hud', 'config.json');

export function normLang(v) {
  const s = String(v || '').trim().toLowerCase().replace('_', '-');
  if (!s || s === 'auto') return null;
  if (s.startsWith('zh')) return 'zh-TW';
  if (s.startsWith('en')) return 'en';
  return null;
}

export function systemLang() {
  let loc = '';
  try { loc = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { /* ignore */ }
  return normLang(loc || process.env.LC_ALL || process.env.LANG) || 'en';
}

export function configuredLang() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')).lang || 'auto'; } catch { return 'auto'; }
}

export function getLang() {
  return normLang(process.env.PROGRESS_HUD_LANG) || normLang(configuredLang()) || systemLang();
}

export function setLang(value) {
  const v = value === 'auto' ? 'auto' : normLang(value);
  if (!v) throw new Error(`unsupported language: ${value} (use auto, zh-TW or en)`);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* new file */ }
  cfg.lang = v;
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return v;
}

const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m));

export const STRINGS = {
  'zh-TW': {
    core: {
      emptyStep: '（空白步驟）',
      uncategorized: '未分類',
      none: '（無）',
      listSep: '、',
      noLongerListed: '（已不在最新清單）',
      summary: '總進度 {pct}%（{done}/{total}）｜進行中：{current}｜下一項：{next}',
      milestoneFallback: '已完成任務',
      warnStale: 'AI 還在改檔案，但已經 {minutes} 分鐘沒更新進度',
      warnUnformatted: '{count} 個步驟沒照格式寫，暫放在「未分類」',
      warnVerify: '{count} 個步驟 AI 說完成，但檢查條件沒過',
      warnFallback: 'OneDrive 鎖住進度檔，部分資料暫存在本機，下次寫入時會補回',
      checkUnknown: '看不懂的條件：{check}（只支援 file / grep）',
      checkOutside: '路徑在專案外，已拒絕',
      checkFile: '檔案 {path}',
      checkGrepFormat: 'grep 格式：grep 路徑 "文字"',
      checkTooBig: '檔案超過 5MB，不檢查',
      checkGrep: '{path} 內含「{text}」',
      checkMissing: '找不到 {path}',
    },
    hook: {
      prefix: '[進度 HUD]',
      toolCodex: 'update_plan',
      toolClaude: 'TodoWrite（或 TaskUpdate）',
      formatNag: '這些步驟沒有照格式，暫時放在「未分類」：{steps}。下次更新待辦時請改成「F<n> 功能名 › F<n>.<m> 細項」，例如「F1 產品頁 › F1.2 tab 切換」。',
      stepSep: '；',
      replanned: '偵測到計畫大幅改寫，已另存成新版本，舊版仍保留在網頁上。',
      started: '進度 HUD 已啟動：{url}',
      allDone: '進度 HUD：全部 {total} 項完成 🎉',
      editReminder: '你已經修改了 {count} 次檔案，但還沒更新進度。如果有步驟完成或開始了，請現在用 {tool} 更新狀態。目前：{summary}',
      prevDone: '上一個任務已全部完成。',
      activePlan: '這個專案有進行中的計畫。',
      fullPlanFollows: '以下是完整計畫，請沿用相同編號繼續：',
      sessionBanner: '進度 HUD：{pct}% ｜ {url}',
      pausedNote: '（使用者表示要暫停，這一輪不需要推進計畫）',
      keepUpdating: '請在每完成或開始一個步驟時立即更新待辦清單，並沿用相同編號。',
      promptLine: '{summary}。{note}',
      stopReason: '這一輪你修改了 {count} 次檔案，但沒有更新進度。請先用 {tool} 把已完成／進行中的步驟狀態補上（沿用相同編號），再結束。如果這一輪的修改不影響任何步驟，直接結束即可。目前：{summary}',
    },
    cli: {
      noData: '（{root} 還沒有進度資料）',
      hudLabel: '進度 {pct}%',
      serverFailed: '伺服器啟動失敗，請看 {log}',
      langNow: '目前語言：{lang}（設定：{setting}）',
      langSet: '語言已設為 {lang}。網頁會在一分鐘內或重新整理後套用；AI 收到的規則與提醒從下一個工作階段開始改用新語言；Claude 側邊欄需要重新啟動 Claude Code。',
    },
    install: {
      backup: '備份 {file}',
      wrote: '寫入 {file}',
      hudChained: 'claude-hud 狀態列加上進度（原本的 extra-cmd 仍會顯示：{cmd}）',
      hudAdded: 'claude-hud 狀態列加上進度',
      hudSkipped: '沒有偵測到 claude-hud 狀態列，略過狀態列整合（網頁與側邊欄不受影響）',
      done: '完成。接下來：\n 1. Codex：開 Codex 後執行 /hooks，信任 progress-hud 的 4 個 hook（Desktop 也一樣）\n 2. Claude Code：重新啟動 Claude Code（狀態列與側邊欄需要重啟才會載入）\n 3. 打開 {url}',
      removed: '已移除 progress-hud 的 hooks、規則與側邊欄設定（各專案的 .progress/ 資料保留）。',
      hudAlready: '狀態列已經有進度了',
      legacyHooks: '移除舊版寫在 settings.json 的 hooks（改由外掛提供）',
      legacyRules: '移除舊版寫在 {file} 的規則（改由 hook 每次開場提供）',
      dCodexLocal: 'Codex：使用本機安裝（~/.codex/hooks.json，{n}/4 個事件）',
      dClaudeLocal: 'Claude Code：使用本機安裝（CLAUDE_CODE_PLUGIN_DIRS）',
      dStatusOn: 'Claude 狀態列：已加上進度',
      dStatusOff: 'Claude 狀態列：未整合（選用，可執行 progress.mjs statusline）',
      dServer: '網頁伺服器 {url}',
      dHook: '{agent} hook 回報：{info}',
      dHookNever: '還沒收到（Codex 需要先在 /hooks 信任）',
      dProjects: '已登記專案：{n} 個',
      dLang: '語言：{lang}',
      dLog: '錯誤紀錄：{file}',
    },
    rules: {
      title: '## 專案進度 HUD（progress-hud）',
      toolCodex: '`update_plan`',
      toolClaude: '`TodoWrite`（或 `TaskCreate` / `TaskUpdate`）',
      start: '- 規劃完成、開始執行前，先用 {tool} 把整份計畫寫進待辦清單。',
      planMode: '- 用 plan mode 規劃時，計畫書裡用 `## F1 功能名` 當功能標題、`- [ ] F1.1 細項` 當步驟，離開 plan mode 時進度會自動建立。',
      format: '- 每個步驟一律用這個格式：`F<n> 功能名 › F<n>.<m> 細項`，例如 `F1 產品頁模板 › F1.2 tab 切換`。需要更細時可以用 `F1.2.1`。',
      numbering: '- 同一個功能的步驟共用同一個 `F<n>`。中途改計畫時沿用原本的編號，不要重新編號；新增的步驟接續往後編。',
      status: '- 開始一個步驟就標成 in_progress，完成後立刻標成 completed，不要累積到最後才一次更新。',
      extras: '- 可選：在步驟最後加上完成條件 `[check: file 相對路徑]` 或 `[check: grep 相對路徑 "文字"]`，進度網頁會自動驗證；加上 `[w:3]` 可以調整權重。',
      small: '- 只有 1～2 個步驟的小任務可以不用編號。',
      url: '- 進度網頁：{url}（hook 會自動啟動）',
    },
    web: {
      htmlLang: 'zh-Hant',
      title: '專案進度 HUD',
      live: '即時連線',
      pickProject: '選擇專案',
      themeDark: '深色', themeLight: '淺色',
      loading: '載入中…',
      noProjects: '（沒有專案）',
      emptyTitle: '還沒有任何專案的進度',
      emptyBody: '在 Codex 或 Claude 裡開始一個任務，AI 第一次建立待辦清單時，進度就會出現在這裡。',
      emptyFormat: '待辦格式：',
      emptyExample: 'F1 功能名 › F1.1 細項',
      noSteps: '這個任務還沒有步驟。',
      itemsDone: '{done} / {total} 項完成',
      paused: '暫停中', allDone: '全部完成',
      lastPlan: '進度最後更新：{ago}', lastEdit: '最後改檔案：{ago}', epoch: '第 {n} 個任務',
      current: '進行中', next: '下一項', none: '（無）',
      features: '功能進度',
      sessions: 'AI 工作階段與計畫版本',
      pausedShort: '暫停',
      replans: '計畫改過 {n} 次：',
      versionInfo: 'v{v}（{ago}建立，{reason}）',
      reasonReplan: '計畫改寫', reasonFirst: '初版',
      milestones: '已完成的里程碑',
      msMeta: '{total} 項・{ago}', view: '查看', back: '← 回到目前進度',
      completedAt: '完成於 {date}', msTotal: '{total} 項',
      stDone: '完成', stDoing: '進行中', stTodo: '待做', stDeleted: '刪除',
      tagMissing: '已不在最新清單', tagDeleted: '已刪除',
      tagVerified: '已驗證完成', tagFailed: 'AI 說完成，檢查沒過',
      checkLabel: '條件：{check}', checkTitle: '完成條件',
      subagent: '小幫手（{type}）：',
      hookNever: '{agent} hook：還沒收到回報',
      hookNeverCodex: '（請在 Codex 執行 /hooks，信任 progress-hud 的 hook）',
      hookLast: '{agent} hook：最後回報 {ago}（{event}）',
      agoNever: '從未', agoNow: '剛剛', agoMin: '{n} 分鐘前', agoHour: '{n} 小時前', agoDay: '{n} 天前',
      workerSep: '、',
    },
    pane: {
      title: '專案進度',
      command: '開啟專案進度側邊欄（總進度／功能／細項）',
      emptyTitle: '專案進度',
      emptyBody: '還沒有進度資料。',
      emptyHint: 'AI 用「F1 功能名 › F1.1 細項」建立待辦後，這裡會自動顯示。',
      cmdHas: '進度 {pct}%（{done}/{total}）｜網頁：{url}',
      cmdNone: '這個專案還沒有進度。AI 建立待辦清單（F1 功能 › F1.1 細項）後就會出現。',
      paused: '・暫停中',
      updated: '進度更新：{ago}',
      current: '進行中 ', next: '下一項 ', none: '（無）',
      more: '…還有 {n} 行，完整內容看網頁',
      tagFailed: '檢查沒過', tagVerified: '已驗證', tagMissing: '已不在清單',
      subagent: '（{type}）',
      agoNever: '從未', agoNow: '剛剛', agoMin: '{n} 分鐘前', agoHour: '{n} 小時前',
      workerSep: '、',
    },
  },

  en: {
    core: {
      emptyStep: '(empty step)',
      uncategorized: 'Uncategorized',
      none: '(none)',
      listSep: ', ',
      noLongerListed: ' (no longer in the list)',
      summary: 'Progress {pct}% ({done}/{total}) | In progress: {current} | Next: {next}',
      milestoneFallback: 'Completed task',
      warnStale: 'The AI is still editing files but has not updated progress for {minutes} minutes',
      warnUnformatted: 'Steps not in the F<n> format (listed under Uncategorized): {count}',
      warnVerify: 'Steps marked done by the AI that failed their check: {count}',
      warnFallback: 'OneDrive locked a progress file; some data is saved locally and will be written back on the next update',
      checkUnknown: 'Unknown check: {check} (only file / grep are supported)',
      checkOutside: 'Path is outside the project; refused',
      checkFile: 'File {path}',
      checkGrepFormat: 'grep format: grep <path> "text"',
      checkTooBig: 'File is larger than 5 MB; not checked',
      checkGrep: '{path} contains "{text}"',
      checkMissing: '{path} not found',
    },
    hook: {
      prefix: '[Progress HUD]',
      toolCodex: 'update_plan',
      toolClaude: 'TodoWrite (or TaskUpdate)',
      formatNag: 'These steps do not follow the format and are listed under Uncategorized for now: {steps}. Next time you update the to-do list, write them as "F<n> Feature › F<n>.<m> Step", for example "F1 Product page › F1.2 Tab switching".',
      stepSep: '; ',
      replanned: 'The plan was largely rewritten. It is saved as a new version; the previous version is still available on the dashboard.',
      started: 'Progress HUD started: {url}',
      allDone: 'Progress HUD: all steps done ({total}) 🎉',
      editReminder: 'You have made {count} file edits without updating progress. If any step has started or finished, update its status now with {tool}. Current: {summary}',
      prevDone: 'The previous task is complete.',
      activePlan: 'This project has a plan in progress.',
      fullPlanFollows: 'Here is the full plan; keep using the same numbers:',
      sessionBanner: 'Progress HUD: {pct}% | {url}',
      pausedNote: '(The user asked to pause; no need to advance the plan this turn.)',
      keepUpdating: 'Update the to-do list as soon as a step starts or finishes, and keep the same numbers.',
      promptLine: '{summary}. {note}',
      stopReason: 'You made {count} file edits this turn but did not update progress. Before finishing, use {tool} to record which steps are done or in progress (keep the same numbers). If this turn\'s edits do not affect any step, you can finish now. Current: {summary}',
    },
    cli: {
      noData: '(no progress data for {root} yet)',
      hudLabel: 'Progress {pct}%',
      serverFailed: 'The server did not start; see {log}',
      langNow: 'Current language: {lang} (setting: {setting})',
      langSet: 'Language set to {lang}. The dashboard picks it up within a minute or on reload; the agent gets the rules and reminders in the new language from its next session; restart Claude Code for the side pane.',
    },
    install: {
      backup: 'Backed up {file}',
      wrote: 'Wrote {file}',
      hudChained: 'Added progress to the claude-hud status line (your existing extra-cmd is still shown: {cmd})',
      hudAdded: 'Added progress to the claude-hud status line',
      hudSkipped: 'claude-hud status line not found; skipped status line integration (dashboard and side pane are unaffected)',
      done: 'Done. Next:\n 1. Codex: run /hooks in Codex and trust the 4 progress-hud hooks (CLI and Desktop)\n 2. Claude Code: restart it so the status line and side pane load\n 3. Open {url}',
      removed: 'Removed progress-hud hooks, rules and side pane settings (each project\'s .progress/ folder is kept).',
      hudAlready: 'The status line already shows progress',
      legacyHooks: 'Removed hooks an older version wrote into settings.json (the plugin provides them now)',
      legacyRules: 'Removed rules an older version wrote into {file} (the hook provides them at session start now)',
      dCodexLocal: 'Codex: local install (~/.codex/hooks.json, {n}/4 events)',
      dClaudeLocal: 'Claude Code: local install (CLAUDE_CODE_PLUGIN_DIRS)',
      dStatusOn: 'Claude status line: shows progress',
      dStatusOff: 'Claude status line: not integrated (optional; run progress.mjs statusline)',
      dServer: 'Dashboard server {url}',
      dHook: '{agent} hook last reported: {info}',
      dHookNever: 'never (Codex needs the hooks trusted in /hooks first)',
      dProjects: 'Registered projects: {n}',
      dLang: 'Language: {lang}',
      dLog: 'Error log: {file}',
    },
    rules: {
      title: '## Project progress HUD (progress-hud)',
      toolCodex: '`update_plan`',
      toolClaude: '`TodoWrite` (or `TaskCreate` / `TaskUpdate`)',
      start: '- When planning is done and before you start, write the whole plan into the to-do list with {tool}.',
      planMode: '- In plan mode, use `## F1 Feature name` headings for features and `- [ ] F1.1 Step` bullets for steps; progress is created when you leave plan mode.',
      format: '- Write every step as `F<n> Feature name › F<n>.<m> Step name`, for example `F1 Product page › F1.2 Tab switching`. Use `F1.2.1` for finer steps.',
      numbering: '- Steps of the same feature share the same `F<n>`. When the plan changes, keep the existing numbers; number new steps after the last one.',
      status: '- Mark a step in_progress when you start it and completed as soon as it is done; do not batch updates until the end.',
      extras: '- Optional: end a step with `[check: file relative/path]` or `[check: grep relative/path "text"]` so the dashboard can verify it; add `[w:3]` to change its weight.',
      small: '- Small tasks with only 1–2 steps do not need numbers.',
      url: '- Dashboard: {url} (started automatically by the hooks)',
    },
    web: {
      htmlLang: 'en',
      title: 'Project Progress HUD',
      live: 'Live connection',
      pickProject: 'Choose project',
      themeDark: 'Dark', themeLight: 'Light',
      loading: 'Loading…',
      noProjects: '(no projects)',
      emptyTitle: 'No project progress yet',
      emptyBody: 'Start a task in Codex or Claude. Progress appears here as soon as the AI creates its first to-do list.',
      emptyFormat: 'To-do format:',
      emptyExample: 'F1 Feature › F1.1 Step',
      noSteps: 'This task has no steps yet.',
      itemsDone: '{done} / {total} done',
      paused: 'Paused', allDone: 'All done',
      lastPlan: 'Progress updated: {ago}', lastEdit: 'Last file edit: {ago}', epoch: 'Task #{n}',
      current: 'In progress', next: 'Next', none: '(none)',
      features: 'Features',
      sessions: 'AI sessions and plan versions',
      pausedShort: 'Paused',
      replans: 'Plan versions:',
      versionInfo: 'v{v} (created {ago}, {reason})',
      reasonReplan: 'rewrite', reasonFirst: 'first version',
      milestones: 'Completed milestones',
      msMeta: 'Steps: {total} · {ago}', view: 'View', back: '← Back to current progress',
      completedAt: 'Completed {date}', msTotal: 'Steps: {total}',
      stDone: 'Done', stDoing: 'In progress', stTodo: 'To do', stDeleted: 'Deleted',
      tagMissing: 'No longer in the list', tagDeleted: 'Deleted',
      tagVerified: 'Verified', tagFailed: 'Marked done, check failed',
      checkLabel: 'Check: {check}', checkTitle: 'Completion check',
      subagent: 'Subagent ({type}): ',
      hookNever: '{agent} hook: no reports yet',
      hookNeverCodex: ' (run /hooks in Codex and trust the progress-hud hooks)',
      hookLast: '{agent} hook: last report {ago} ({event})',
      agoNever: 'never', agoNow: 'just now', agoMin: '{n} min ago', agoHour: '{n} h ago', agoDay: '{n} days ago',
      workerSep: ', ',
    },
    pane: {
      title: 'Project progress',
      command: 'Open the project progress side pane (project / features / steps)',
      emptyTitle: 'Project progress',
      emptyBody: 'No progress data yet.',
      emptyHint: 'This fills in once the AI creates a to-do list like "F1 Feature › F1.1 Step".',
      cmdHas: 'Progress {pct}% ({done}/{total}) | Dashboard: {url}',
      cmdNone: 'This project has no progress yet. It appears once the AI creates a to-do list (F1 Feature › F1.1 Step).',
      paused: ' · paused',
      updated: 'Progress updated: {ago}',
      current: 'In progress ', next: 'Next ', none: '(none)',
      more: '…more rows ({n}); see the dashboard for everything',
      tagFailed: 'check failed', tagVerified: 'verified', tagMissing: 'no longer listed',
      subagent: '({type}) ',
      agoNever: 'never', agoNow: 'just now', agoMin: '{n} min ago', agoHour: '{n} h ago',
      workerSep: ', ',
    },
  },
};

// t('core.summary', { pct: 50 }) in the active language; falls back to English, then the key.
export function t(key, vars, lang = getLang()) {
  const [ns, k] = key.split('.');
  const s = STRINGS[lang]?.[ns]?.[k] ?? STRINGS.en[ns]?.[k] ?? key;
  return fill(s, vars);
}

export function bundle(ns, lang = getLang()) {
  return { ...STRINGS.en[ns], ...STRINGS[lang]?.[ns] };
}
