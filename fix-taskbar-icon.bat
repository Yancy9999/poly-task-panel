@echo off
REM Clear Windows taskbar/desktop icon cache.
REM Fixes: app window title icon shows OK but taskbar shows a blue placeholder.
REM Note: explorer restarts (desktop flashes briefly); open Explorer windows close.

cd /d "%USERPROFILE%"

echo Stopping explorer...
taskkill /F /IM explorer.exe >nul 2>&1

echo Clearing icon cache...
if exist "%LOCALAPPDATA%\IconCache.db" del /F /Q "%LOCALAPPDATA%\IconCache.db" 2>nul
if exist "%LOCALAPPDATA%\Microsoft\Windows\Explorer" (
  del /F /Q "%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db" 2>nul
)

echo Restarting explorer...
start explorer.exe

echo Done. Relaunch the app and check the taskbar icon.
timeout /t 3 >nul
