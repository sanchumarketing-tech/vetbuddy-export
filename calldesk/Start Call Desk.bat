@echo off
title Sanchu Call Desk (local)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing the app the first time - this takes a minute...
  call npm install --no-audit --no-fund
)
echo.
echo Sanchu Call Desk is running at http://localhost:3000  - keep this window open while testing.
start "" http://localhost:3000
call npx vite --port 3000 --strictPort
pause
