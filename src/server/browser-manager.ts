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
      
      // 動的フィールド対応: ページ読み込み後、追加の待機
      // JSフレームワーク（React/Vue等）のレンダリング完了を待つ
      await new Promise(r => setTimeout(r, 1000));
      
      // networkidleも待つ（APIリクエスト完了待ち）
      await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      
      // さらに少し待って、遅延レンダリングに対応
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

      // 最初の収集
      let fields = await collectPageFields(this.page);
      
      // フィールドが少ない場合、追加待機して再収集（動的フィールド対応）
      if (fields.length < 3) {
        await new Promise(r => setTimeout(r, 1500));
        const retryFields = await collectPageFields(this.page);
        if (retryFields.length > fields.length) {
          this.log('info', `🔄 追加フィールドを検出: ${fields.length} → ${retryFields.length}`);
          fields = retryFields;
        }
      }
      
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

        // stepNumber順にソートして実行
        const sortedInputs = [...testCase.pageInputs].sort((a, b) => a.stepNumber - b.stepNumber);

        // 全ステップを順番に実行（ログイン画面も含む）
        for (let i = 0; i < sortedInputs.length; i++) {
          const pageInput = sortedInputs[i];
          const sessionPage = session.pages.find(p => p.stepNumber === pageInput.stepNumber);

          this.send({
            type: 'replay:progress',
            payload: {
              caseId: testCase.caseId,
              step: i + 1,
              total: sortedInputs.length,
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
          let navigationDetected = false;
          for (const field of fieldsToFill) {
            if (navigationDetected) break; // ページ遷移後は残フィールドをスキップ

            const displayValue = field.type === 'password' ? '****' : field.value;
            appendLog('debug', `[${testCase.caseId}] 入力試行: [${field.type}] selector="${field.selector}" value="${displayValue}"`);
            try {
              await inputHandler.fillField(page, field);
              // 入力後にポップアップが残っていれば閉じる
              await page.keyboard.press('Escape').catch(() => {});
              await page.waitForTimeout(100);
              appendLog('debug', `[${testCase.caseId}] 入力成功: [${field.type}] ${field.label || field.selector} = "${displayValue}"`);
              this.log('info', `[${testCase.caseId}] ✅ 入力: [${field.type}] ${field.label || field.selector} = "${displayValue}"`);
            } catch (err: any) {
              // ページ遷移によるコンテキスト破壊を検出
              const isContextDestroyed =
                err.message?.includes('context was destroyed') ||
                err.message?.includes('Execution context') ||
                err.message?.includes('Target page, context or browser has been closed');

              if (isContextDestroyed) {
                this.log('warn', `[${testCase.caseId}] ⚠️ ページ遷移を検出 → 残りフィールドをスキップして次のステップへ`);
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                navigationDetected = true;
              } else {
                // 通常エラー
                await page.keyboard.press('Escape').catch(() => {});
                this.log('warn', `[${testCase.caseId}] ❌ 入力エラー [${field.type}] selector="${field.selector}": ${err.message}`);
                appendLog('debug', `[${testCase.caseId}] エラー詳細: ${err.stack || err.message}`);
              }
            }
          }

          // 入力後キャプチャ
          const afterPath = path.join(screenshotDir, `step${String(pageInput.stepNumber).padStart(2, '0')}_after.png`);
          await page.screenshot({ path: afterPath, fullPage: this.settings.screenshot.fullPage });
          screenshots.push(afterPath);

          // 送信ボタンクリック → 次画面へ遷移
          let submitSelector = pageInput.submitSelector || sessionPage?.submitSelector;

          // submitSelector が空の場合、自動検出を試みる
          if (!submitSelector) {
            this.log('info', `[${testCase.caseId}] 🔍 送信ボタンを自動検出中...`);
            const autoDetected = await page.evaluate(() => {
              // 優先度順に検索（セレクタパターン）
              const patterns = [
                'button[type="submit"]:not([disabled])',
                'input[type="submit"]:not([disabled])',
                'a[href^="javascript:"]:not([disabled])',  // javascript: リンク追加
                'a.nextBtn:not([disabled])',
                'a.nextBtn2:not([disabled])',
                'button.btn-primary:not([disabled])',
                'button.submit:not([disabled])',
                'a.btn-primary:not([disabled])',
                'a.btn-submit:not([disabled])',
                '.btn-start:not([disabled])',
                '.submit-btn:not([disabled])',
              ];
              // テキストパターン（日本語保険サイト対応を強化）
              const textPatterns = [
                '次へ', '進む', '確認', '送信', '完了', '登録', '保存',
                'スタート', '診断', '開始', '申込', '見積',
                'next', 'submit', 'confirm', 'start'
              ];

              for (const pattern of patterns) {
                const el = document.querySelector(pattern) as HTMLElement | null;
                if (el && el.offsetParent !== null) {
                  const id = el.id ? `#${el.id}` : null;
                  const className = el.className ? `.${el.className.split(' ')[0]}` : null;
                  const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : null;
                  return id || className || name || pattern;
                }
              }

              // テキストマッチで検索（button, a, input, div等を広く検索）
              const allClickables = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')) as HTMLElement[];
              for (const btn of allClickables) {
                if (btn.offsetParent === null) continue; // 非表示はスキップ
                const text = btn.textContent?.trim().toLowerCase() || '';
                const value = (btn as HTMLInputElement).value?.toLowerCase() || '';
                const combined = text + ' ' + value;
                for (const keyword of textPatterns) {
                  if (combined.includes(keyword.toLowerCase())) {
                    const id = btn.id ? `#${btn.id}` : null;
                    const className = btn.className ? `.${btn.className.split(' ')[0]}` : null;
                    const name = btn.getAttribute('name') ? `[name="${btn.getAttribute('name')}"]` : null;
                    const tagName = btn.tagName.toLowerCase();
                    const textContent = btn.textContent?.trim().substring(0, 20) || value;
                    return id || className || name || `${tagName}:has-text("${textContent}")`;
                  }
                }
              }
              return null;
            });

            if (autoDetected) {
              this.log('info', `[${testCase.caseId}] 🎯 自動検出: ${autoDetected}`);
              submitSelector = autoDetected;
            } else {
              this.log('warn', `[${testCase.caseId}] ⚠️ 送信ボタンが見つかりません`);
            }
          }

          if (submitSelector) {
            try {
              const btn = page.locator(submitSelector).first();

              // ボタンが表示されるまで待機（最大5秒）
              await btn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

              // disabled 属性が外れるまで待機（Playwright locator で判定）
              let isEnabled = false;
              for (let attempt = 0; attempt < 16; attempt++) {  // 最大8秒 (500ms x 16)
                try {
                  isEnabled = await btn.isEnabled();
                  if (isEnabled) break;
                } catch { /* ページ遷移中は無視 */ }
                await page.waitForTimeout(500);
              }

              if (!isEnabled) {
                this.log('warn', `[${testCase.caseId}] ⚠️ ボタンが有効化されませんでした (クリックを試みます): ${submitSelector}`);
              } else {
                this.log('info', `[${testCase.caseId}] ✅ ボタン活性化を確認`);
              }

              // クリック前のURL/コンテンツを記録
              const urlBefore = page.url();
              const contentHashBefore = await page.evaluate(() => {
                const main = document.querySelector('main, #main, .main, [role="main"], form, body');
                return main ? main.innerHTML.length : 0;
              }).catch(() => 0);

              // 少し待ってからクリック（JSアニメーション等の完了待ち）
              await page.waitForTimeout(300);
              this.log('info', `[${testCase.caseId}] 🖱️ 送信クリック: ${submitSelector}`);
              
              // クリック方法を複数試行
              let clickSuccess = false;
              
              // href="javascript:..." の場合は特別処理
              const hrefJs = await btn.evaluate((el: HTMLElement) => {
                const href = el.getAttribute('href') || '';
                if (href.startsWith('javascript:')) {
                  return href.replace('javascript:', '');
                }
                return null;
              });
              
              if (hrefJs) {
                // javascript: リンクの場合、JSコードを直接実行
                this.log('info', `[${testCase.caseId}] 🔗 javascript: リンクを検出 → JS直接実行`);
                try {
                  await page.evaluate((code: string) => {
                    // グローバルスコープで実行
                    eval(code);
                  }, hrefJs);
                  clickSuccess = true;
                } catch (e: any) {
                  this.log('warn', `[${testCase.caseId}] JS直接実行失敗: ${e.message}, 通常クリックを試行`);
                }
              }
              
              if (!clickSuccess) {
                // 1. 通常クリック
                try {
                  await btn.click({ timeout: 3000 });
                  clickSuccess = true;
                } catch (e1: any) {
                  this.log('warn', `[${testCase.caseId}] 通常クリック失敗: ${e1.message}, force クリックを試行`);
                  
                  // 2. force クリック
                  try {
                    await btn.click({ force: true, timeout: 3000 });
                    clickSuccess = true;
                  } catch (e2: any) {
                    this.log('warn', `[${testCase.caseId}] force クリック失敗: ${e2.message}, JS クリックを試行`);
                    
                    // 3. JavaScript で直接クリック
                    try {
                      await btn.evaluate((el: HTMLElement) => {
                        el.click();
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                      });
                      clickSuccess = true;
                    } catch (e3: any) {
                      this.log('error', `[${testCase.caseId}] ❌ 全てのクリック方法が失敗: ${e3.message}`);
                    }
                  }
                }
              }

              if (clickSuccess) {
                // 遷移を待機
                await page.waitForLoadState('domcontentloaded', { timeout: this.settings.timeout.navigation }).catch(() => {});
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(500);
                
                // 遷移を検証
                const urlAfter = page.url();
                const contentHashAfter = await page.evaluate(() => {
                  const main = document.querySelector('main, #main, .main, [role="main"], form, body');
                  return main ? main.innerHTML.length : 0;
                }).catch(() => 0);
                
                const urlChanged = urlAfter !== urlBefore;
                const contentChanged = Math.abs(contentHashAfter - contentHashBefore) > 100;
                
                if (urlChanged) {
                  this.log('info', `[${testCase.caseId}] ✅ ページ遷移を確認: ${urlBefore} → ${urlAfter}`);
                } else if (contentChanged) {
                  this.log('info', `[${testCase.caseId}] ✅ ページ内容の変化を確認 (SPA遷移)`);
                } else {
                  this.log('warn', `[${testCase.caseId}] ⚠️ ページ遷移が検出されませんでした（入力不足の可能性）`);
                  // スクリーンショットを追加保存
                  const stuckPath = path.join(screenshotDir, `step${String(pageInput.stepNumber).padStart(2, '0')}_stuck.png`);
                  await page.screenshot({ path: stuckPath, fullPage: this.settings.screenshot.fullPage });
                  screenshots.push(stuckPath);
                }
              }
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
