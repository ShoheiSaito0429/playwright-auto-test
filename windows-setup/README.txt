========================================
  OpenClaw Windows Setup Guide
========================================

Requirements:
- Node.js v18+
- Anthropic account (for OAuth)
- Telegram Bot token (optional)

Setup Steps:

1. Run install-openclaw.bat as Administrator
   -> OpenClaw will be installed
   -> Browser opens -> Login with Anthropic account

2. Edit openclaw.json:
   - workspace: Your work directory
   - botToken: Telegram bot API token

3. Copy openclaw.json to:
   %USERPROFILE%\.openclaw\openclaw.json

4. Start OpenClaw:
   openclaw gateway start

5. Talk to your bot on Telegram

OAuth login later:
   openclaw auth login

========================================
  Playwright Auto Test
========================================

1. In playwright-auto-test folder:
   npm install

2. Start server:
   npx tsx src/server/index.ts

3. Open browser: http://localhost:3200

4. Ask OpenClaw to test the recording

========================================
