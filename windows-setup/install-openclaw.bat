@echo off
echo ========================================
echo   OpenClaw Windows Installer
echo ========================================
echo.

echo [1/4] Installing OpenClaw...
npm install -g openclaw
if %errorlevel% neq 0 (
    echo [!] Install failed
    pause
    exit /b 1
)

echo.
echo [2/4] Version check...
openclaw --version

echo.
echo [3/4] Creating config directory...
if not exist "%USERPROFILE%\.openclaw" mkdir "%USERPROFILE%\.openclaw"

echo.
echo [4/4] OAuth login...
echo     Browser will open. Login with your Anthropic account.
openclaw auth login

echo.
echo ========================================
echo   Install Complete!
echo ========================================
echo.
echo Next steps:
echo   1. Edit openclaw.json in this folder
echo      - Set botToken (Telegram)
echo      - Set workspace path
echo.
echo   2. Copy openclaw.json to:
echo      %USERPROFILE%\.openclaw\
echo.
echo   3. Start: openclaw gateway start
echo.
pause
