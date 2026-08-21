@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo  purge-tokens.bat — strip garmin_tokens.json from ALL
echo  git history and force-push both remotes.
echo  This REWRITES HISTORY. Other clones must be re-cloned.
echo ============================================================
echo.
set CONFIRM=
set /p CONFIRM="Type YES to proceed: "
if /i not "%CONFIRM%"=="YES" (
  echo Aborted.
  pause
  exit /b 1
)

echo.
echo [1/6] Checking for git-filter-repo...
git filter-repo --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo   Not found - installing via pip...
  pip install git-filter-repo
  git filter-repo --version >nul 2>&1
  if %ERRORLEVEL% neq 0 (
    echo   ERROR: could not install git-filter-repo. Install Python/pip first.
    pause
    exit /b 1
  )
)

echo [2/6] Saving remote URLs (filter-repo removes them)...
for /f "delims=" %%u in ('git remote get-url personal') do set PERSONAL_URL=%%u
for /f "delims=" %%u in ('git remote get-url origin') do set ORIGIN_URL=%%u
if "%PERSONAL_URL%"=="" ( echo ERROR: no 'personal' remote & pause & exit /b 1 )
if "%ORIGIN_URL%"==""   ( echo ERROR: no 'origin' remote   & pause & exit /b 1 )

echo [3/6] Removing stale lock file if present...
if exist .git\index.lock del .git\index.lock

echo [4/6] Rewriting history to remove garmin_tokens.json...
git filter-repo --invert-paths --path garmin_tokens.json --force
if %ERRORLEVEL% neq 0 (
  echo ERROR: filter-repo failed. Nothing was pushed.
  pause
  exit /b 1
)

echo [5/6] Restoring remotes...
git remote add personal "%PERSONAL_URL%" 2>nul || git remote set-url personal "%PERSONAL_URL%"
git remote add origin   "%ORIGIN_URL%"   2>nul || git remote set-url origin   "%ORIGIN_URL%"

echo [6/6] Force-pushing rewritten history...
echo   Pushing to personal (jaschro/logtrim)...
git push personal main --force
echo   Pushing to origin (logtrim/logtrim)...
git push origin main --force

echo.
echo ============================================================
echo  Done. Verify on GitHub that garmin_tokens.json is gone
echo  from the file list AND from old commits in the history.
echo  Note: GitHub may cache old commit views for a while.
echo ============================================================
pause
