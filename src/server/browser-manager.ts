import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { RecordingSession, RecordedPage, Settings, TestCase, ReplayResult, WSMessage } from '../types.js';
import { collectPageFields, installFieldWatcher } from './field-collector.js';
import { InputHandler } from './input-handler.js';

type SendFn = (msg: WSMessage) => void;

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.resolve('data/logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${date}.log`);
}

function appendLog(level: string, message: string): void {
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const line = `[${time}] [${level.toUpperCase()}] ${message}\n`;
  try {
    fs.appendFileSync(getLogFilePath(), line, 'utf-8');
  } catch { /* ログ失敗は無視 */ }
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private settings: Settings;
  private send: SendFn;
  private recording = false;
  private session: RecordingSession | null = null;
  private stepCounter = 0;

  constructor(settings: Settings, send: SendFn) {
    this.settings = settings;
    this.send = send;
  }

  updateSend(send: SendFn) {
    this.send = send;
  }

  private log(level: 'info' | 'warn' | 'error', message: string) {
    this.send({ type: 'log', payload: { level, message } });
    const icon = level === 'info' ? 'ℹ️' : level === 'warn' ? '⚠️' : '❌';
    console.log(`${icon} ${message}`);
    appendLog(level, message);
  }

  // ===== 記録モード =====

  async startRecording(startUrl: string): Promise<void> {
    if (this.browser) await this.cleanup();

    this.log('info', 'ブラウザを起動中...');
    this.browser = await chromium.launch({
      headless: this.settings.browser.headless,
      slowMo: this.settings.browser.slowMo,
    });
    this.context = await this.browser.newContext({
      viewport: this.settings.browser.viewport,
    });
    this.page = await this.context.newPage();
    this.recording = true;
    this.stepCounter = 0;

    this.session = {
      id: uuid(),
      name: `recording_${timestamp()}`,
      startUrl,
      pages: [],
      startedAt: new Date().toISOString(),
      completedAt: '',
    };

    // ページ遷移・読み込み完了時にフィールドを自動収集
    this.page.on('load', async () => {
      if (!this.recording || !this.page) return;
      await this.autoCollectFields();
    });

    // SPA対応: URL変化を検知
    this.page.on('framenavigated', async (frame) => {
      if (!this.recording || !this.page || frame !== this.page.mainFrame()) return;
      await new Promise(r => setTimeout(r, 1000));
      await this.autoCollectFields();
    });

    this.log('info', `ページを開いています: ${startUrl}`);
    await this.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: this.settings.timeout.navigation });
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // MutationObserver は load イベント内の autoCollectFields() で注入済みのため、
    // ここでは二重登録を避けるために再呼び出しを省略

    this.send({
      type: 'recording:status',
      payload: { status: 'recording', url: this.page.url(), step: 0 },
    });
    this.send({
      type: 'browser:navigated',
      payload: { url: this.page.url(), title: await this.page.title() },
    });

    this.log('info', '📹 記録開始 — ログイン画面を含めて全操作を手動で行ってください');
  }

  private async autoCollectFields(): Promise<void> {
    if (!this.page || !this.recording) return;

    try {
      await this.page.waitForLoadState('domcontentloaded');
      await new Promise(r => setTimeout(r, 500));

      const url = this.page.url();
      const title = await this.page.title();

      this.send({
        type: 'browser:navigated',
        payload: { url, title },
      });

      // ページ遷移後にMutationObserverを再注入
      try {
        await installFieldWatcher(this.page, () => {
          this.log('info', '🔄 フィールド状態の変化を検知 → 再収集中...');
          this.autoCollectFields();
        });
      } catch { /* 既に注入済みの場合は無視 */ }

      const fields = await collectPageFields(this.page);
      if (fields.length === 0) return;

      this.stepCounter++;
      const pageId = uuid();

      const recordedPage: RecordedPage = {
        id: pageId,
        url,
        title,
        stepNumber: this.stepCounter,
        fields,
        recordedAt: new Date().toISOString(),
      };

      // 送信ボタン検出
      const submitInfo = await this.page.evaluate(() => {
        const candidates = [
          ...Array.from(document.querySelectorAll('button[type="submit"]')),
          ...Array.from(document.querySelectorAll('input[type="submit"]')),
          ...Array.from(document.querySelectorAll('button')).filter(b =>
            /次へ|送信|確認|完了|登録|保存|ログイン|サインイン|submit|next|confirm|save|login|sign.?in/i.test(b.textContent || '')
          ),
        ];
        if (candidates.length === 0) return null;
        const el = candidates[0] as HTMLElement;
        let selector = '';
        if (el.id) selector = `#${el.id}`;
        else if (el.getAttribute('name')) selector = `[name="${el.getAttribute('name')}"]`;
        else if (el.getAttribute('type') === 'submit') selector = '[type="submit"]';
        else selector = `button:has-text("${el.textContent?.trim().substring(0, 20)}")`;
        return { selector, text: el.textContent?.trim() || '' };
      });

      if (submitInfo) {
        recordedPage.submitSelector = submitInfo.selector;
        recordedPage.submitText = submitInfo.text;
      }

      this.send({
        type: 'recording:page-collected',
        payload: recordedPage,
      });
      this.send({
        type: 'fields:collected',
        payload: { pageId, fields },
      });

      this.log('info', `ステップ${this.stepCounter}: ${fields.length}個のフィールドを検出 (${title})`);
    } catch (err: any) {
      this.log('warn', `フィールド収集エラー: ${err.message}`);
    }
  }

  async manualCollect(): Promise<void> {
    await this.autoCollectFields();
  }

  async captureCurrentValues(): Promise<RecordedPage | null> {
    if (!this.page || !this.recording) return null;
    const fields = await collectPageFields(this.page);
    const pageId = uuid();
    const recordedPage: RecordedPage = {
      id: pageId,
      url: this.page.url(),
      title: await this.page.title(),
      stepNumber: this.stepCounter,
      fields,
      recordedAt: new Date().toISOString(),
    };
    this.send({ type: 'recording:page-collected', payload: recordedPage });
    return recordedPage;
  }

  async stopRecording(pages: RecordedPage[]): Promise<RecordingSession | null> {
    if (!this.session) return null;
    this.recording = false;

    this.session.pages = pages;
    this.session.completedAt = new Date().toISOString();

    const dir = path.resolve('data/recordings');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${this.session.name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(this.session, null, 2), 'utf-8');

    this.log('info', `記録を保存しました: ${filePath}`);
    this.send({ type: 'recording:complete', payload: this.session });

    await this.cleanup();
    return this.session;
  }

  // ===== 再生モード =====
  // ログイン画面もステップ1として扱う。全画面同じロジックで入力→送信を繰り返す。

  async startReplay(session: RecordingSession, testCases: TestCase[]): Promise<void> {
    const inputHandler = new InputHandler();
    const results: ReplayResult[] = [];
    const enabledCases = testCases.filter(c => c.enabled);

    this.log('info', `${enabledCases.length}件のテストケースを実行します`);

    for (const testCase of enabledCases) {
      const startTime = Date.now();
      const screenshotDir = path.resolve('data/screenshots', `${testCase.caseId}_${timestamp()}`);
      fs.mkdirSync(screenshotDir, { recursive: true });
      const screenshots: string[] = [];

      const browser = await chromium.launch({
        headless: this.settings.browser.headless,
        slowMo: this.settings.browser.slowMo,
      });

      try {
        const context = await browser.newContext({ viewport: this.settings.browser.viewport });
        const page = await context.newPage();
        page.setDefaultTimeout(this.settings.timeout.action);

        // 開始URL（記録時の最初のページ）に移動
        const startUrl = session.startUrl || session.pages[0]?.url;
        if (!startUrl) throw new Error('開始URLが不明です');

        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: this.settings.timeout.navigation });
        // networkidle を best-effort で待つ（タイムアウトしても続行）
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

        // 全ステップを順番に実行（ログイン画面も含む）
        for (let i = 0; i < testCase.pageInputs.length; i++) {
          const pageInput = testCase.pageInputs[i];
          const sessionPage = session.pages.find(p => p.stepNumber === pageInput.stepNumber);

          this.send({
            type: 'replay:progress',
            payload: {
              caseId: testCase.caseId,
              step: i + 1,
              total: testCase.pageInputs.length,
              status: `ステップ${pageInput.stepNumber}実行中...`,
            },
          });

          // 入力前キャプチャ
          const beforePath = path.join(screenshotDir, `step${String(pageInput.stepNumber).padStart(2, '0')}_before.png`);
          await page.screenshot({ path: beforePath, fullPage: this.settings.screenshot.fullPage });
          screenshots.push(beforePath);

          // 入力
          const fieldsToFill = pageInput.fieldValues.filter(f => f.value !== '');
          this.log('info', `[${testCase.caseId}] ステップ${pageInput.stepNumber}: ${fieldsToFill.length}個のフィールドを入力 (URL: ${page.url()})`);
          for (const field of fieldsToFill) {
            const displayValue = field.type === 'password' ? '****' : field.value;
            appendLog('debug', `[${testCase.caseId}] 入力試行: [${field.type}] selector="${field.selector}" value="${displayValue}"`);
            try {
              await inputHandler.fillField(page, field);
              appendLog('debug', `[${testCase.caseId}] 入力成功: [${field.type}] ${field.label || field.selector} = "${displayValue}"`);
              this.log('info', `[${testCase.caseId}] ✅ 入力: [${field.type}] ${field.label || field.selector} = "${displayValue}"`);
            } catch (err: any) {
              this.log('warn', `[${testCase.caseId}] ❌ 入力エラー [${field.type}] selector="${field.selector}": ${err.message}`);
              appendLog('debug', `[${testCase.caseId}] エラー詳細: ${err.stack || err.message}`);
            }
          }

          // 入力後キャプチャ
          const afterPath = path.join(screenshotDir, `step${String(pageInput.stepNumber).padStart(2, '0')}_after.png`);
          await page.screenshot({ path: afterPath, fullPage: this.settings.screenshot.fullPage });
          screenshots.push(afterPath);

          // 送信ボタンクリック → 次画面へ遷移
          const submitSelector = pageInput.submitSelector || sessionPage?.submitSelector;
          if (submitSelector) {
            try {
              this.log('info', `[${testCase.caseId}] 送信: ${submitSelector}`);
              await page.locator(submitSelector).click();
              await page.waitForLoadState('domcontentloaded', { timeout: this.settings.timeout.navigation });
              await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            } catch (err: any) {
              this.log('warn', `[${testCase.caseId}] 遷移エラー: ${err.message}`);
            }
          }
        }

        // 最終画面キャプチャ
        const finalPath = path.join(screenshotDir, 'final.png');
        await page.screenshot({ path: finalPath, fullPage: this.settings.screenshot.fullPage });
        screenshots.push(finalPath);

        results.push({
          caseId: testCase.caseId,
          caseName: testCase.caseName,
          status: 'success',
          screenshots,
          duration: Date.now() - startTime,
        });

        this.log('info', `[${testCase.caseId}] ✅ 完了`);

      } catch (err: any) {
        this.log('error', `[${testCase.caseId}] ❌ エラー: ${err.message}`);
        results.push({
          caseId: testCase.caseId,
          caseName: testCase.caseName,
          status: 'error',
          error: err.message,
          screenshots,
          duration: Date.now() - startTime,
        });
      } finally {
        await browser.close();
      }
    }

    const resultPath = path.resolve('data/screenshots', `result_${timestamp()}.json`);
    fs.writeFileSync(resultPath, JSON.stringify(results, null, 2), 'utf-8');
    this.send({ type: 'replay:complete', payload: { results } });
  }

  async cleanup(): Promise<void> {
    this.recording = false;
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
