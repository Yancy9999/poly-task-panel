@echo off
cd /d "%~dp0"

REM Kill any process still listening on port 7777 (leftover node from a previous run)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7777.*LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

start "" http://localhost:7777
node server.js
pause
