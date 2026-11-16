@echo off
REM ==============================================================================
REM Coinbase Crypto Bot - Windows Setup & Deployment Wizard
REM ==============================================================================

setlocal enabledelayedexpansion
title Coinbase Crypto Bot - Setup Wizard
color 0B
cls

echo ==================================================================
echo           COINBASE CRYPTO BOT - WINDOWS SETUP WIZARD
echo    Automated HFT/DCA Cryptocurrency Trading Engine ^& Terminal
echo ==================================================================
echo.

cd /d "%~dp0"

REM ------------------------------------------------------------------------------
REM 1. Check Node.js Runtime (Version >= 22)
REM ------------------------------------------------------------------------------
echo [1/5] Verifying Node.js Runtime...

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in your PATH.
    echo Node.js 22 LTS or newer is required for native embedded SQLite.
    echo.
    echo Please download and install Node.js 22 from:
    echo https://nodejs.org/
    echo.
    echo Once installed, reopen this script.
    pause
    exit /b 1
)

for /f "tokens=1 delims=v" %%v in ('node -v') do set "NODE_FULL=%%v"
for /f "tokens=1 delims=." %%m in ('node -v') do set "NODE_MAJ=%%m"
set "NODE_MAJ=%NODE_MAJ:v=%"

if %NODE_MAJ% lss 22 (
    color 0C
    echo [ERROR] Node.js version is too old: %NODE_FULL%
    echo Node.js 22 LTS or newer is required for native SQLite.
    echo Please update Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo   [OK] Node.js %NODE_FULL% detected.
echo.

REM ------------------------------------------------------------------------------
REM 2. Interactive Prompts (Smart Defaults)
REM ------------------------------------------------------------------------------
echo [2/5] Network ^& Administrative Configuration...
echo Tip: Press [ENTER] to accept recommended defaults.
echo.

set "FQDN=localhost"
set /p "INPUT_FQDN=1. Domain or IP [Default: localhost]: "
if not "%INPUT_FQDN%"=="" set "FQDN=%INPUT_FQDN%"
echo   - Target Domain: %FQDN%
echo.

set "PORT=29600"
set /p "INPUT_PORT=2. Web Server Port [Default: 29600]: "
if not "%INPUT_PORT%"=="" set "PORT=%INPUT_PORT%"
echo   - Listening Port: %PORT%
echo.

set "ADMIN_USER=admin"
set /p "INPUT_ADMIN_USER=3. Admin Username [Default: admin]: "
if not "%INPUT_ADMIN_USER%"=="" set "ADMIN_USER=%INPUT_ADMIN_USER%"

set "ADMIN_PASS="
set /p "ADMIN_PASS=4. Admin Password (or press [ENTER] to auto-generate): "
if "%ADMIN_PASS%"=="" (
    for /f "tokens=*" %%p in ('node -e "console.log('CbBot-' + require('crypto').randomBytes(4).toString('hex') + '-' + require('crypto').randomBytes(4).toString('hex'))"') do set "ADMIN_PASS=%%p"
    echo   * Generated Admin Password: !ADMIN_PASS! (Please save this!)
) else (
    echo   - Admin password set.
)
echo.

REM ------------------------------------------------------------------------------
REM 3. Coinbase Exchange API Setup
REM ------------------------------------------------------------------------------
echo [3/5] Coinbase Exchange API Setup...
echo.
echo ==================================================================
echo         HOW TO GET YOUR COINBASE ADVANCED TRADE API KEYS
echo ==================================================================
echo 1. Visit: https://portal.cdp.coinbase.com/access/api
echo 2. Click [Create API Key], check [View] and [Trade]
echo    (NEVER check Transfer or Withdraw)
echo 3. Save the downloaded 'cdp_api_key.json' file or copy the keys.
echo ==================================================================
echo.

set "COINBASE_API_KEY="
set "COINBASE_API_SECRET="
set "COINBASE_SYMBOL=ETH/USD"
set "COINBASE_CAPITAL=25.00"

if exist "cdp_api_key.json" (
    echo * Detected 'cdp_api_key.json' in this directory!
    set "USE_JSON=y"
    set /p "USE_JSON=Auto-import keys from this file? (y/n) [Default: y]: "
    if /i "!USE_JSON!"=="y" (
        for /f "tokens=*" %%k in ('node -e "try { const d = JSON.parse(require('fs').readFileSync('cdp_api_key.json', 'utf8')); console.log(d.name || ''); } catch(e){}"') do set "COINBASE_API_KEY=%%k"
        for /f "tokens=*" %%s in ('node -e "try { const d = JSON.parse(require('fs').readFileSync('cdp_api_key.json', 'utf8')); console.log(d.privateKey || ''); } catch(e){}"') do set "COINBASE_API_SECRET=%%s"
        echo   [OK] Auto-imported Coinbase CDP credentials!
    )
)

if "!COINBASE_API_KEY!"=="" (
    echo Setup Option:
    echo   [1] Enter path to 'cdp_api_key.json'
    echo   [2] Enter keys manually
    echo   [3] Skip for now (configure anytime via web dashboard) [Default]
    set "CB_CHOICE=3"
    set /p "CB_CHOICE=Choice [1/2/3, Default: 3]: "
    if "!CB_CHOICE!"=="1" (
        set /p "JSON_PATH=Path to cdp_api_key.json: "
        if exist "!JSON_PATH!" (
            for /f "tokens=*" %%k in ('node -e "try { const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(d.name || ''); } catch(e){}" "!JSON_PATH!"') do set "COINBASE_API_KEY=%%k"
            for /f "tokens=*" %%s in ('node -e "try { const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(d.privateKey || ''); } catch(e){}" "!JSON_PATH!"') do set "COINBASE_API_SECRET=%%s"
            echo   [OK] Successfully imported credentials!
        ) else (
            echo   [!] File not found. Skipping keys for now.
        )
    ) else if "!CB_CHOICE!"=="2" (
        set /p "COINBASE_API_KEY=Coinbase API Key Name: "
        set /p "COINBASE_API_SECRET=Coinbase Private Key (or path to .pem file): "
    ) else (
        echo   - Skipping API keys for now. You can connect anytime via the dashboard.
    )
)

if not "!COINBASE_API_KEY!"=="" (
    set /p "COINBASE_SYMBOL=Trading Pair [Default: ETH/USD]: "
    if "!COINBASE_SYMBOL!"=="" set "COINBASE_SYMBOL=ETH/USD"
    set /p "COINBASE_CAPITAL=Allocated Capital ($) [Default: 25.00]: "
    if "!COINBASE_CAPITAL!"=="" set "COINBASE_CAPITAL=25.00"
)
echo.

REM ------------------------------------------------------------------------------
REM 4. Generate Secrets & Environment
REM ------------------------------------------------------------------------------
echo [4/5] Generating Cryptographic Environment ^& Building...

for /f "tokens=*" %%e in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set "ENCRYPTION_KEY=%%e"
for /f "tokens=*" %%s in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set "SESSION_SECRET=%%s"

(
echo PORT=%PORT%
echo HOST=0.0.0.0
echo FQDN=%FQDN%
echo BASE_PATH=/
echo ENCRYPTION_KEY=%ENCRYPTION_KEY%
echo SESSION_SECRET=%SESSION_SECRET%
echo ROOT_ADMIN_USER=%ADMIN_USER%
echo DATA_DIR=%~dp0data
) > "%~dp0.env"

echo   [OK] Generated .env with AES-256-GCM encryption keys.

if not exist "%~dp0node_modules" (
    echo   - Installing npm dependencies...
    call npm install
)

echo   - Compiling TypeScript source...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo [ERROR] TypeScript compilation failed.
    pause
    exit /b 1
)
echo   [OK] Production build complete.

REM Bootstrap SQLite database
if not exist "%~dp0data" mkdir "%~dp0data"
echo   - Bootstrapping database schema ^& security...
set "ADMIN_USER=%ADMIN_USER%"
set "ADMIN_PASS=%ADMIN_PASS%"
set "ENCRYPTION_KEY=%ENCRYPTION_KEY%"
set "COINBASE_API_KEY=!COINBASE_API_KEY!"
set "COINBASE_API_SECRET=!COINBASE_API_SECRET!"
set "COINBASE_SYMBOL=!COINBASE_SYMBOL!"
set "COINBASE_CAPITAL=!COINBASE_CAPITAL!"
node "%~dp0scripts\bootstrap.js"

echo.

REM ------------------------------------------------------------------------------
REM 5. Summary & Launch
REM ------------------------------------------------------------------------------
echo ==================================================================
echo           COINBASE CRYPTO BOT SETUP COMPLETED!
echo ==================================================================
echo.
echo Terminal URL:     http://localhost:%PORT%/
echo Admin Username:   %ADMIN_USER%
echo Admin Password:   %ADMIN_PASS%
echo Database File:    %~dp0data\trading.db
echo.
echo Control Scripts:
echo   start.bat   - Launches the trading engine
echo   status.bat  - Checks process status and port
echo   stop.bat    - Stops the running trading engine
echo.

set "LAUNCH_NOW=y"
set /p "LAUNCH_NOW=Would you like to start Coinbase Crypto Bot now? (y/n) [Default: y]: "
if /i "%LAUNCH_NOW%"=="y" (
    start http://localhost:%PORT%/
    call "%~dp0start.bat"
)

pause
