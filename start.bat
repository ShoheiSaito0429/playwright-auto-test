@echo off
cd /d "%~dp0"

echo ========================================
echo  Playwright Auto Test
echo ========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo Please install Node.js LTS from https://nodejs.org
    echo.
    pause
    start https://nodejs.org
    exit /b 1
)

if not exist "node_modules\" (
    echo [Setup] Installing packages...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )

    echo [Setup] Installing Playwright browser...
    call npx playwright install chromium
    if %errorlevel% neq 0 (
        echo [ERROR] Playwright install failed.
        pause
        exit /b 1
    )
    echo.
    echo [Setup] Done!
    echo.
)

echo Server starting on port 3200...
echo Close this window to stop the server.
echo.

start /b cmd /c "timeout /t 2 /nobreak > nul && start http://localhost:3200"

node --import tsx/esm src/server/index.ts
