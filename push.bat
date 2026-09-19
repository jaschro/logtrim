@echo off
setlocal
cd /d "%~dp0"

set FILES=equipment/generic/gym.json equipment/generic/images/strength-training-class.jpg equipment/generic/images/water-aerobics-class.jpg equipment/generic/images/pilates-mat-class.jpg equipment/generic/images/pilates-reformer-class.jpg

echo ===============================================================
echo  LogTrim push - four new classes in the generic gym
echo ---------------------------------------------------------------
echo  Strength Training / Water Aerobics / Pilates Mat / Pilates Reformer
echo.
echo  1. jaschro/logtrim  (your fork)
echo  2. logtrim/logtrim  (the template)
echo  Only these paths are staged:
echo     equipment\generic\gym.json
echo     equipment\generic\images\strength-training-class.jpg
echo     equipment\generic\images\water-aerobics-class.jpg
echo     equipment\generic\images\pilates-mat-class.jpg
echo     equipment\generic\images\pilates-reformer-class.jpg
echo ===============================================================
echo.

echo Removing stale lock file if present...
if exist .git\index.lock del .git\index.lock

REM ---------------------------------------------------------------
REM  Pre-flight
REM ---------------------------------------------------------------
echo Checking that Claude's files are in place...
for %%C in (strength-training-class water-aerobics-class pilates-mat-class pilates-reformer-class) do (
  findstr /C:"%%C" equipment\generic\gym.json >nul 2>&1
  if errorlevel 1 (
    echo.
    echo  ERROR: equipment\generic\gym.json does not mention %%C.
    pause
    exit /b 1
  )
  if not exist equipment\generic\images\%%C.jpg (
    echo.
    echo  ERROR: equipment\generic\images\%%C.jpg is missing.
    pause
    exit /b 1
  )
)
echo   ...gym.json and all four images found.
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
echo Staging the five files (explicit paths - nothing else is touched)...
git add %FILES%
echo.
echo Staged for jaschro/logtrim:
git diff --cached --name-only
echo.
choice /C YN /M "Commit these"
if %ERRORLEVEL% neq 1 ( echo Aborted by user. Unstaging... & git reset & pause & exit /b 1 )

git commit -m "Add four classes to the generic gym" -m "Strength Training, Water Aerobics, Pilates Mat and Pilates Reformer added to the Classes room of equipment/generic (logType mins), each with its illustration." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01Mhn3agjMda2MJwWkz222i5"
if %ERRORLEVEL% neq 0 ( echo Commit failed - aborting. & pause & exit /b 1 )

echo.
echo Pushing to personal (jaschro/logtrim)...
git push personal main
if %ERRORLEVEL% neq 0 (
  echo.
  echo Direct push rejected - personal/main has moved (the app writes your log there).
  echo Rebasing onto personal/main and retrying...
  git pull personal main --rebase
  if %ERRORLEVEL% neq 0 (
    echo.
    echo Rebase hit a conflict. Nothing was pushed. Run "git rebase --abort" and tell Claude.
    pause
    exit /b 1
  )
  git push personal main
  if %ERRORLEVEL% neq 0 ( echo Push to personal FAILED - see above. & pause & exit /b 1 )
)
echo.
echo Files in the commit that landed on personal:
git show --stat HEAD
echo.

REM ---------------------------------------------------------------
REM  2. Template repo (logtrim/logtrim) - clean branch off origin/main
REM     so no personal workout data can travel with it.
REM ---------------------------------------------------------------
echo ===============================================================
echo  Now pushing the same five files to logtrim/logtrim
echo ===============================================================
git fetch origin main
if %ERRORLEVEL% neq 0 ( echo Fetch of origin failed - aborting. & pause & exit /b 1 )

git checkout -b sync-origin origin/main
if %ERRORLEVEL% neq 0 ( echo Could not create sync-origin branch - aborting. & pause & exit /b 1 )

git checkout main -- %FILES%
git add %FILES%

echo.
echo Files staged for logtrim/logtrim (should be exactly these five):
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

git commit -m "Add four classes to the generic gym" -m "Strength Training, Water Aerobics, Pilates Mat and Pilates Reformer added to the Classes room of equipment/generic (logType mins), each with its illustration. Forks pick them up via scripts/updater.js, which syncs the equipment/generic/ prefix." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01Mhn3agjMda2MJwWkz222i5"

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
echo  Done. Fork and template both updated.
echo  Still to do by hand: logtrim/gyms (the catalog) - see chat.
echo ===============================================================
pause
