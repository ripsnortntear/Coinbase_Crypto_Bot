@echo off
REM ==============================================================================
REM Coinbase Crypto Bot - Windows Start Script
REM ==============================================================================

title Coinbase Crypto Bot - Running
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    pause
    exit /b 1
)

if not exist "%~dp0dist\index.js" (
    echo [INFO] Compiling TypeScript source...
    call npm run build
)

echo Starting Coinbase Crypto Bot...
node "%~dp0dist\index.js"
pause
