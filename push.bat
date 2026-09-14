@echo off
cd /d "%~dp0"
echo Removing stale lock file if present...
if exist .git\index.lock del .git\index.lock
echo Running tests...
node --test tests/utils.test.js
if %ERRORLEVEL% neq 0 (
  echo Tests failed — aborting push.
  pause
  exit /b 1
)
echo Committing changes...
git add -A
git commit -m "Make Generic gym editable in the equipment manager"
echo Pulling and pushing to personal (jaschro/logtrim)...
git pull personal main --rebase -X theirs
git push personal main
echo.
REM --- origin (logtrim/logtrim) push disabled ---
REM The template repo has a rewritten, divergent history: "git pull origin
REM main --rebase" tries to replay ~565 personal commits onto it, stalls on
REM conflicts, and would push personal workout data into the shared repo.
REM To send a change to origin, cherry-pick it onto a branch off origin/main:
REM   git fetch origin main
REM   git checkout -b sync-origin origin/main
REM   git checkout main -- <file>
REM   git commit -m "..." ^&^& git push origin sync-origin:main
REM   git checkout main ^&^& git branch -D sync-origin
echo.
echo Done! Check above for any errors.
pause
