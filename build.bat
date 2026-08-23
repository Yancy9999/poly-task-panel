@echo off
cd /d "%~dp0"

REM Rust toolchain lives in user dir; make sure cargo is on PATH
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

REM Download a pinned node win-x64 binary into src-tauri\bundled-node\ (used by release to run server.js,
REM so node-pty's native .node ABI always matches the runtime node). ~40MB, only on first run or version change.
node src-tauri\fetch-node.js
if errorlevel 1 (
  echo [build] Failed to download node binary, aborting
  pause
  exit /b 1
)

REM Build release exe + NSIS installer into src-tauri\target\release\bundle\
npx tauri build
pause
