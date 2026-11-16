@echo off
REM ==============================================================================
REM Coinbase Crypto Bot - Windows Status Script
REM ==============================================================================

cd /d "%~dp0"
set "PORT=29600"

if exist "%~dp0.env" (
    for /f "tokens=1,2 delims==" %%a in ('findstr /r "^PORT=" "%~dp0.env"') do (
        set "PORT=%%b"
    )
)

echo ==================================================================
echo          COINBASE CRYPTO BOT - WINDOWS PROCESS STATUS
echo ==================================================================
echo.

set "FOUND=0"
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r ":%PORT% .*LISTENING"') do (
    set "PID=%%a"
    echo Status:  RUNNING
    echo PID:     %%a
    echo Port:    %PORT%
    set "FOUND=1"
)

if "%FOUND%"=="0" (
    echo Status:  STOPPED (Not listening on port %PORT%)
) else (
    echo.
    echo Testing API Health...
    powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/api/system/status' -TimeoutSec 2; Write-Host ('Uptime: ' + [math]::Round($r.data.uptime) + 's | Active Bots: ' + $r.data.activeBots + ' | Memory: ' + $r.data.memory.rssMb + ' MB') } catch { Write-Host 'Engine starting up...' }"
)

echo.
pause
