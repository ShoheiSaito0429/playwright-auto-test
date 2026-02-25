@echo off
chcp 65001 > nul
title Playwright Auto Test

echo ========================================
echo  Playwright Auto Test - Windows版
echo ========================================
echo.

:: Node.js チェック
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [エラー] Node.js がインストールされていません。
    echo https://nodejs.org から LTS版をインストールしてください。
    echo.
    pause
    start https://nodejs.org
    exit /b 1
)

:: node_modules がなければ初回セットアップ
if not exist "node_modules\" (
    echo [初回セットアップ] 依存パッケージをインストール中...
    call npm install
    if %errorlevel% neq 0 (
        echo [エラー] npm install に失敗しました
        pause
        exit /b 1
    )

    echo [初回セットアップ] ブラウザをインストール中...
    call npx playwright install chromium
    if %errorlevel% neq 0 (
        echo [エラー] Playwright ブラウザのインストールに失敗しました
        pause
        exit /b 1
    )
    echo.
    echo [セットアップ完了]
    echo.
)

:: サーバー起動
echo サーバーを起動中... (ポート 3200)
echo 停止するにはこのウィンドウを閉じてください
echo.

:: 少し待ってからブラウザを開く
start /b cmd /c "timeout /t 2 /nobreak > nul && start http://localhost:3200"

:: サーバー本体を起動（このウィンドウがある間は動き続ける）
node --import tsx/esm src/server/index.ts
