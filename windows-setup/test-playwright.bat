@echo off
chcp 65001 >nul
echo ========================================
echo   Playwright Auto Test 検証
echo ========================================
echo.

cd /d "%~dp0.."
if not exist "node_modules" (
    echo [1/2] 依存関係をインストール中...
    call npm install
)

echo.
echo [2/2] テスト実行...
echo.
call npx tsx src/server/index.ts

pause
