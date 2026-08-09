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
git commit -m "Fix walk duration display — show M:SS not decimal minutes"
echo Pulling and pushing to personal (jaschro/logtrim)...
git pull personal main --rebase -X theirs
git push personal main
echo.
echo Pulling and pushing to origin (logtrim/logtrim)...
git pull origin main --rebase -X theirs
git push origin main
echo.
echo Done! Check above for any errors.
pause
