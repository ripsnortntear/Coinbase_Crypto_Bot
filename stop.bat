@echo off
REM ==============================================================================
REM Coinbase Crypto Bot - Windows Stop Script
REM ==============================================================================

cd /d "%~dp0"
set "PORT=29600"

if exist "%~dp0.env" (
    for /f "tokens=1,2 delims==" %%a in ('findstr /r "^PORT=" "%~dp0.env"') do (
        set "PORT=%%b"
    )
)

echo Stopping Coinbase Crypto Bot on port %PORT%...

set "FOUND=0"
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r ":%PORT% .*LISTENING"') do (
    set "PID=%%a"
    echo Killing process with PID !PID!...
    taskkill /PID %%a /F >nul 2>nul
    set "FOUND=1"
)

if "%FOUND%"=="1" (
    echo [OK] Coinbase Crypto Bot stopped.
) else (
    echo [INFO] No running bot process found on port %PORT%.
)

pause
