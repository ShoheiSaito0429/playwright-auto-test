@echo off
cd /d "%~dp0"
chcp 65001 > nul
echo ========================================
echo   Playwright Auto Test v2.8.0
echo ========================================
echo.
if not exist "node_modules" (
    echo npm install...
    call npm install
    echo.
    echo Playwright install...
    call npx playwright install chromium
    echo.
)
echo Starting server...
echo Open: http://localhost:3200
echo.
echo Ctrl+C to stop.
echo.
npx tsx src/server/index.ts
pause
