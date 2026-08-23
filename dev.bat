@echo off
cd /d "%~dp0"

REM Rust toolchain lives in user dir; make sure cargo is on PATH
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

REM Dev mode: compile Rust shell + spawn node server.js (dynamic port) + open WebView2 window
npx tauri dev
pause
