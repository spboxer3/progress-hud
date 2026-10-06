---
name: progress
description: Open the progress-hud project dashboard once. Starts the local dashboard server on 127.0.0.1:7788 if it is not running and opens the current project's progress page, unless a dashboard is already open. Use only when the user types /progress or $progress, or asks to open the progress dashboard. Do not use it to update progress.
---

# Open the progress dashboard

1. Run the plugin's command-line tool with the current working directory as the project to show. `bin/progress.mjs` is two folders above this skill's folder:

   ```
   node "<this skill's folder>/../../bin/progress.mjs" open "<current working directory>"
   ```

   It starts the dashboard server in the background when needed and prints the dashboard URL. It opens the default browser only when no dashboard page is open yet; an open page (Codex side panel or browser tab) updates itself.

2. If the command fails because of the sandbox (the server cannot start or the port cannot be reached), rerun the same command with escalated permissions. Do not try other ways of starting the server.

3. Reply with one line: the printed URL. If it failed, show the error and suggest running the same tool with `doctor` instead of `open`.

Run this once per request. Do not run it again on later turns, and never to "update" or "refresh" the progress page: the page updates on its own. To record progress, update the to-do list (`update_plan`), or, without that tool, use the `progress plan` command given in the session rules.

Do not change any files.
