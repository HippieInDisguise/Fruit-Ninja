@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node is not installed - this needs it to run.
  echo   Get it from https://nodejs.org ^(press the LTS button^), then open this again.
  echo.
  pause
  exit /b 1
)
node server.js
echo.
pause
