@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0\.."

set /p NODE_VERSION=<.nvmrc
set REQUIRED_NODE=v%NODE_VERSION%

echo [YAAA] Checking Windows prerequisites...

where node >nul 2>nul
if errorlevel 1 (
  echo [YAAA] Node.js was not found. Attempting install with winget...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo [YAAA] winget is not available. Install Node.js %NODE_VERSION% or newer, then run this file again.
    exit /b 1
  )
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [YAAA] npm was not found. Reopen your terminal after Node.js installs, then run this file again.
  exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set CURRENT_NODE=%%i
if not "%CURRENT_NODE%"=="%REQUIRED_NODE%" (
  echo [YAAA] Expected %REQUIRED_NODE% from .nvmrc; found %CURRENT_NODE%.
  echo [YAAA] Continuing, but the pinned version is recommended.
)

echo [YAAA] Installing JavaScript dependencies...
call npm install
if errorlevel 1 exit /b %errorlevel%

echo [YAAA] Rebuilding Electron native modules...
call npx electron-rebuild -f -w better-sqlite3 --module-dir apps/ui
if errorlevel 1 exit /b %errorlevel%

echo [YAAA] Starting YAAA...
call npm run dev:ui
