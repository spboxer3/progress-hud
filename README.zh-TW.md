# progress-hud

[English](README.md) | **繁體中文**

給 AI 寫程式助手用的即時進度看板。**Codex**（CLI 與 Desktop）或 **Claude Code**（CLI 與 Desktop）執行任務時，progress-hud 會讀取 AI 的待辦清單，用三個層級顯示進度：

- **專案**：整體完成度
- **功能**：每個功能（F1、F2…）的完成度
- **細項**：功能底下每個步驟的狀態

```
官網改版                                   43%   3 / 7 項完成
███████████████░░░░░░░░░░░░░░░░░░░

F1 產品頁模板                        2/3  67%
   ✓ F1.1 規格表元件                 已驗證完成
   ✓ F1.2 tab 切換
   ▸ F1.3 圖片輪播                   進行中 · Codex
F2 SEO                              1/2  50%
   ✓ F2.1 meta 標籤                  AI 說完成，檢查沒過
   ○ F2.2 sitemap
```

## 在哪裡看進度

| 工具 | 位置 |
|---|---|
| Codex Desktop | 在側邊欄開啟 `http://127.0.0.1:7788` |
| Codex CLI | 用瀏覽器開啟 `http://127.0.0.1:7788` |
| Claude Code（CLI 與 Desktop） | 有計畫後，側邊欄會自動開啟「專案進度」面板；隨時輸入 `/progress` 也能打開 |
| 有安裝 claude-hud 狀態列外掛的 Claude Code | 狀態列顯示進度百分比（選用，見下方） |

看板會即時更新，在側邊欄的寬度下也能正常顯示，並提供淺色與深色主題。

## 系統需求

- Node.js 20 以上，且可以直接用 `node` 指令執行
- 支援外掛與 hooks 的 Codex CLI 或 Codex Desktop，以及（或）Claude Code
- Git 不是必要的；專案是 git 儲存庫時，所有 worktree 會共用同一份進度

在 Windows 11 上開發與測試。hook、伺服器和看板都是純 Node.js，但 `open` 指令、指令啟動檔與 claude-hud 狀態列整合使用的是 Windows 指令。

## 安裝

### Claude Code

```
claude plugin marketplace add spboxer3/progress-hud
claude plugin install progress-hud@progress-hud
```

也可以在 Claude Code 裡輸入 `/plugin marketplace add spboxer3/progress-hud`，再輸入 `/plugin install progress-hud@progress-hud`。安裝完成後重新啟動 Claude Code。

### Codex（CLI 與 Desktop）

```
codex plugin marketplace add spboxer3/progress-hud
codex plugin add progress-hud@progress-hud
```

接著開一個新的 Codex 工作階段，輸入 `/hooks`，信任 progress-hud 的 hook。Codex 在你信任之前不會執行新的 hook，CLI 和 Desktop 都要各做一次。

### 狀態列（選用，Claude Code + claude-hud）

在 Claude Code 輸入 `/progress statusline`，再重新啟動。如果你的 claude-hud 已經設定了 `--extra-cmd`，它會繼續運作：progress-hud 會代為執行它，並把它的標籤顯示在進度旁邊。

### 檢查安裝

在 Claude Code 輸入 `/progress doctor`；或是在第一個工作階段開始之後，於終端機執行：

```
%LOCALAPPDATA%\progress-hud\progress.cmd doctor
```

### 更新

```
claude plugin marketplace update progress-hud
codex plugin marketplace upgrade progress-hud
```

### 改用本機複本安裝

```
git clone https://github.com/spboxer3/progress-hud.git
cd progress-hud
node bin/progress.mjs install
```

這會把複本註冊成 Claude Code 外掛資料夾（`~/.claude/settings.json` 的 `CLAUDE_CODE_PLUGIN_DIRS`），把 Codex 的 hook 加進 `~/.codex/hooks.json`，並加上 claude-hud 狀態列整合。每個被修改的檔案都會先備份成 `<檔名>.bak-progress-hud-<時間>`。marketplace 和本機複本請擇一使用，兩種同時安裝的話，每個 hook 都會執行兩次。

## 讓看板看得懂的計畫寫法

AI 每次開始工作階段時都會收到這些規則，你自己下指令時也可以照著寫。

**步驟格式**

```
F<n> 功能名 › F<n>.<m> 細項
```

```
F1 產品頁 › F1.1 規格表元件
F1 產品頁 › F1.2 tab 切換
F2 SEO › F2.1 meta 標籤
```

- 同一個 `F<n>` 的步驟屬於同一個功能。
- 可以再往下分，例如 `F1.2.1`。
- 分隔符號也可以用 `>`、`»`、`→`。
- 沒有編號的步驟會放進「未分類」。計畫有 3 個以上步驟時，會提醒 AI 改成正確格式。

**選用的附加標記**

| 標記 | 效果 |
|---|---|
| `[check: file src/spec.js]` | 這個檔案存在，步驟才算「已驗證完成」 |
| `[check: grep index.html "og:description"]` | 檔案裡有這段文字，步驟才算「已驗證完成」 |
| `[w:3]` | 這個步驟在進度中佔 3 倍份量 |

檢查只會讀取專案內的檔案，不會執行任何指令。AI 標成完成、但檢查沒過的步驟會以紅色顯示。

**Claude Code 的 plan mode**：功能寫成 `## F1 功能名` 標題，步驟寫成 `- [ ] F1.1 細項` 清單。你一同意計畫，進度就會建立。

## Hook 做了什麼

| Hook 事件 | 會發生什麼 |
|---|---|
| `SessionStart` | 把待辦清單規則告訴 AI，需要時啟動看板伺服器。恢復對話或 context 被壓縮後，也會附上目前完整的計畫 |
| `UserPromptSubmit` | 你每送出一則訊息，就附上一行進度摘要給 AI。說「暫停」會停止提醒，說「繼續」恢復 |
| `PostToolUse` | 記錄每一次待辦清單更新（Codex 的 `update_plan`；Claude Code 的 `TodoWrite`、`TaskCreate`、`TaskUpdate` 與 `ExitPlanMode`）。AI 改了 8 次檔案都沒更新進度時提醒它 |
| `Stop` | 這一輪 AI 有改檔案、卻沒更新進度時，請它先更新再結束，同一輪只會要求一次 |

hook 自己出錯時絕對不會擋住 AI：錯誤寫進 `%LOCALAPPDATA%\progress-hud\hook-error.log`，hook 仍然正常結束。

## 值得知道的行為

- **同時開多個 AI**：每個 AI 工作階段各寫一個檔案，看板會合併顯示，並標出哪個 AI 正在做哪個步驟。
- **子代理（subagent）**：子代理的待辦會顯示在主 AI 當時正在做的步驟底下，不會蓋掉主計畫。
- **計畫改寫**：AI 把大部分計畫換掉時，舊計畫會保留成較早的版本，可以在看板上切換查看。
- **新任務**：計畫完成 100% 後又開始一份步驟不同的計畫，完成的那份會封存成里程碑。
- **被拿掉的步驟**：AI 最新清單裡沒有的步驟會保留，標示為「已不在最新清單」，不會刪除，也不計入進度。
- **進度過期**：看板會顯示進度最後更新的時間；AI 持續改檔案卻 10 分鐘沒更新進度時，會亮黃燈。
- **雲端同步資料夾**：OneDrive 等工具鎖住進度檔時，會先重試，仍失敗就暫存在本機，等下次寫入成功時補回。

## 資料放在哪裡

| 路徑 | 內容 |
|---|---|
| `<專案>/.progress/` | 專案的進度資料。裡面附有自己的 `.gitignore`，不會進到你的儲存庫 |
| `%LOCALAPPDATA%\progress-hud\` | 已知專案清單、設定、錯誤紀錄、伺服器 PID，以及 `progress.cmd` / `hud-extra.cmd` 啟動檔 |

看板伺服器只監聽 `127.0.0.1`。AI 開始工作時自動啟動；連續 12 小時沒有進度變動、也沒有人開著看板時自動結束。要換 port，請把 `PROGRESS_HUD_PORT` 設成使用者層級的環境變數，讓 hook 與伺服器都讀得到。

## 指令

在 Claude Code 裡：

```
/progress                       開啟側邊欄面板
/progress status                以文字顯示進度
/progress doctor                檢查安裝狀態
/progress statusline            在 claude-hud 狀態列加上進度
/progress lang auto|en|zh-TW    設定介面語言
```

在終端機裡，`progress.cmd` 會指向已安裝的版本（hook 會自動保持它最新）：

```
%LOCALAPPDATA%\progress-hud\progress.cmd status [資料夾]   以文字顯示進度
%LOCALAPPDATA%\progress-hud\progress.cmd open [資料夾]     開啟看板（需要時自動啟動伺服器）
%LOCALAPPDATA%\progress-hud\progress.cmd serve            在前景執行伺服器
%LOCALAPPDATA%\progress-hud\progress.cmd lang [auto|en|zh-TW]
%LOCALAPPDATA%\progress-hud\progress.cmd statusline
%LOCALAPPDATA%\progress-hud\progress.cmd doctor
%LOCALAPPDATA%\progress-hud\progress.cmd uninstall        移除本機複本安裝與狀態列整合
```

透過 marketplace 移除外掛（`claude plugin uninstall` / `codex plugin remove`）時，會保留各專案的 `.progress/` 資料夾，不需要時請自行刪除。

## 疑難排解

| 狀況 | 檢查方式 |
|---|---|
| `doctor` 顯示 Codex 從未回報 | 在 Codex 用 `/hooks` 信任 hook，再開一個新的工作階段 |
| 看板連不上 | 對 AI 送出任何訊息（會重新啟動伺服器），或執行 `progress.cmd open` |
| 全部步驟都在「未分類」 | AI 沒有使用 `F<n> … › F<n>.<m> …` 格式；開一個新的工作階段，讓它重新收到規則 |
| Claude 側邊欄面板沒出現 | 重新啟動 Claude Code，再輸入 `/progress` |
| hook 執行了兩次 | 同時有 marketplace 安裝和本機複本安裝；執行 `progress.cmd uninstall` 移除本機的那一份 |
| 其他問題 | 查看 `%LOCALAPPDATA%\progress-hud\hook-error.log` |

## 語言

介面提供**繁體中文**與**英文**兩種語言，涵蓋看板、Claude Code 側邊欄面板、狀態列、命令列輸出，以及 hook 傳給 AI 的規則和提醒。

預設跟隨系統語言：任何中文語系都使用繁體中文，其他語系使用英文。要自己指定時，在 Claude Code 輸入 `/progress lang zh-TW`（或 `en`、`auto`），或執行 `progress.cmd lang zh-TW`。

切換後，看板會在一分鐘內或重新整理後套用，AI 從下一個工作階段開始收到新語言，Claude 側邊欄則在重新啟動後套用。環境變數 `PROGRESS_HUD_LANG` 的優先順序高於這個設定。

功能與步驟名稱會照 AI 寫的原文顯示，不限語言。暫停和繼續兩種語言都能辨識，例如「暫停」/ pause、「繼續」/ continue。

## 開發

```
npm test            hook 端到端測試與安裝／移除測試
npm run test:pane   Claude Code 側邊欄面板測試（需要 Claude Code）
```

```
.claude-plugin/        Claude Code 外掛資訊與 marketplace
.agents/plugins/       Codex marketplace
plugin.json            Codex 外掛資訊
hooks/hooks.json       Claude Code 的 hook 與側邊欄模組
hooks/codex-hooks.json Codex 的 hook
hooks/register.tsx     Claude Code 側邊欄面板
bin/hook.mjs           兩種 AI 共用的 hook 入口
bin/server.mjs         看板伺服器
bin/progress.mjs       命令列工具
bin/install.mjs        本機複本安裝、狀態列、移除、doctor
lib/core.mjs           解析、儲存、合併與彙整
lib/i18n.mjs           各語言的介面文字
lib/rules.mjs          傳給 AI 的待辦清單規則
web/index.html         看板
```
