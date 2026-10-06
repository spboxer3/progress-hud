---
name: progress
description: Open the progress-hud project dashboard. Starts the local dashboard server on 127.0.0.1:7788 if it is not running, then opens the current project's progress page in the browser. Use only when the user types /progress or $progress, or asks to open the progress dashboard.
---

# Open the progress dashboard

1. Run the plugin's command-line tool with the current working directory as the project to show. `bin/progress.mjs` is two folders above this skill's folder:

   ```
   node "<this skill's folder>/../../bin/progress.mjs" open "<current working directory>"
   ```

   It starts the dashboard server in the background when needed, opens the default browser, and prints the dashboard URL. When the project has no progress data yet, it opens the dashboard home page instead.

2. If the command fails because of the sandbox (the server cannot start, the port cannot be reached, or the browser does not open), rerun the same command with escalated permissions. Do not try other ways of starting the server.

3. Reply with one line: the printed URL. If it failed, show the error and suggest running the same tool with `doctor` instead of `open`.

Do not change any files.
