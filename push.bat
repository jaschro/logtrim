@echo off
setlocal
cd /d "%~dp0"

echo ===============================================================
echo  LogTrim sync push
echo ---------------------------------------------------------------
echo  This does TWO things:
echo    1. Updates jaschro/logtrim  (app + docs, from the template)
echo    2. Updates logtrim/logtrim  (the three rewritten doc files)
echo ===============================================================
echo.

echo Removing stale lock file if present...
if exist .git\index.lock del .git\index.lock

REM ---------------------------------------------------------------
REM  Pre-flight: the three rewritten docs must already be in place
REM ---------------------------------------------------------------
echo Checking that the new doc files were dropped in...
findstr /C:"Allow network egress" SETUP.md >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo.
  echo  ERROR: SETUP.md is not the new version.
  echo  Copy the three .md files from Claude into this folder first.
  pause
  exit /b 1
)
findstr /C:"suggested-workout.json" Project-Instructions-Template.md >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo.
  echo  ERROR: Project-Instructions-Template.md is not the new version.
  pause
  exit /b 1
)
findstr /C:"nothing extra to deploy" README.md >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo.
  echo  ERROR: README.md is not the new version.
  pause
  exit /b 1
)
echo   ...all three new docs found.
echo.

REM ---------------------------------------------------------------
REM  Pull the template's index.html into this fork
REM ---------------------------------------------------------------
echo Fetching origin (logtrim/logtrim)...
git fetch origin main
if %ERRORLEVEL% neq 0 ( echo Fetch failed - aborting. & pause & exit /b 1 )

echo.
echo About to overwrite your local index.html with the template's version.
echo That adds the gym-catalog feature. Any uncommitted local edits to
echo index.html will be LOST.
echo.
choice /C YN /M "Continue"
if %ERRORLEVEL% neq 1 ( echo Aborted by user. & pause & exit /b 1 )

git checkout origin/main -- index.html
if %ERRORLEVEL% neq 0 ( echo Could not take index.html from origin - aborting. & pause & exit /b 1 )
echo   ...index.html synced from template.
echo.

REM ---------------------------------------------------------------
REM  Tests
REM ---------------------------------------------------------------
echo Running tests...
node --test tests/utils.test.js
if %ERRORLEVEL% neq 0 (
  echo Tests failed - aborting push.
  pause
  exit /b 1
)
echo.

REM ---------------------------------------------------------------
REM  1. Personal fork (jaschro/logtrim)
REM ---------------------------------------------------------------
echo Committing to local main...
git add -A
git commit -m "Sync app from template; drop Cloudflare from the required setup path" -m "index.html taken from logtrim/logtrim (adds gym catalog import). README, SETUP and the coach instructions rewritten so the Claude coach writes suggested-workout.json straight to the GitHub Contents API. worker.js left in place as an optional relay." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GCoT6NFrkVwoyU6Ph3iRRc"

echo.
echo Pulling and pushing to personal (jaschro/logtrim)...
git pull personal main --rebase -X theirs
git push personal main
if %ERRORLEVEL% neq 0 ( echo Push to personal FAILED - see above. & pause & exit /b 1 )
echo.
echo Files in the commit that landed on personal:
git show --stat HEAD
echo.

REM ---------------------------------------------------------------
REM  2. Template repo (logtrim/logtrim) - docs only, via a clean branch
REM     off origin/main so no personal workout data can travel with it.
REM ---------------------------------------------------------------
echo ===============================================================
echo  Now pushing the three doc files to logtrim/logtrim
echo ===============================================================
git fetch origin main
git checkout -b sync-origin origin/main
if %ERRORLEVEL% neq 0 ( echo Could not create sync-origin branch - aborting. & pause & exit /b 1 )

git checkout main -- README.md SETUP.md Project-Instructions-Template.md
git add README.md SETUP.md Project-Instructions-Template.md

echo.
echo Files staged for logtrim/logtrim (should be exactly three .md files):
git diff --cached --name-only
echo.
choice /C YN /M "Push these to logtrim/logtrim"
if %ERRORLEVEL% neq 1 (
  echo Skipping origin push. Cleaning up...
  git checkout main
  git branch -D sync-origin
  pause
  exit /b 0
)

git commit -m "Coach writes plans via the GitHub API; Cloudflare Worker now optional" -m "SETUP Part 2 drops the Cloudflare account, second token and four Worker secrets in favour of reusing the app's existing fine-grained PAT. Project instructions push suggested-workout.json through the Contents API with a sha-aware write and an error-code table. worker.js stays in the repo as an opt-in relay for anyone who would rather Claude not hold a token." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GCoT6NFrkVwoyU6Ph3iRRc"

git push origin sync-origin:main
if %ERRORLEVEL% neq 0 (
  echo.
  echo Push to origin FAILED - origin/main may have moved. Nothing was lost.
  echo Re-run this script, or push the branch manually.
  git checkout main
  git branch -D sync-origin
  pause
  exit /b 1
)

echo Cleaning up the temporary branch...
git checkout main
git branch -D sync-origin

echo.
echo ===============================================================
echo  Done. Both repos updated.
echo  Check above for any errors.
echo ===============================================================
pause
