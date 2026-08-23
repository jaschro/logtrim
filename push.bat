@echo off
cd /d "%~dp0"
echo Removing stale lock file if present...
if exist .git\index.lock del .git\index.lock
echo Running tests...
node --test tests/utils.test.js
if %ERRORLEVEL% neq 0 (
  echo Tests failed - aborting push.
  pause
  exit /b 1
)
echo.
set MSG=
set /p MSG="Commit message (Enter for default): "
if "%MSG%"=="" set MSG=Update app and workout data
echo Committing changes...
git add -A
git commit -m "%MSG%"
echo Pulling and pushing to personal (jaschro/logtrim)...
git pull personal main --rebase -X theirs
git push personal main
echo.
echo NOTE: This does NOT push to origin (logtrim/logtrim).
echo That repo is a clean template - personal data must never
echo go there. Publish template changes deliberately.
echo.
echo Done! Check above for any errors.
pause
