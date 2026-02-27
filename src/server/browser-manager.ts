import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { RecordingSession, RecordedPage, Settings, TestCase, ReplayResult, WSMessage } from '../types.js';
import { collectPageFields, installFieldWatcher } from './field-collector.js';
import { InputHandler } from './input-handler.js';

type SendFn = (msg: WSMessage) => void;

function timestamp(): string {
  const d = new Date();
  return d.getFullYear().toString()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0')
    + String(d.getHours()).padStart(2, '0')
    + String(d.getMinutes()).padStart(2, '0')
    + String(d.getSeconds()).padStart(2, '0');
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
  // ページ遷移前にconsole経由で受け取ったボタンクリック情報（①対応）
  private _pendingClickedSubmit: { selector: string; text: string } | null = null;
  // autoCollectFields の並行実行防止フラグ
  private _collecting = false;
  private _pendingCollect = false;

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

    // ページロード前からクリックリスナーを注入（モーダル等の早期クリックも取り逃さない）
    // ※ 通常のfunction宣言を使用してesbuildの__name注入を回避
    await this.context.addInitScript(`(function() {
      function buildClickSelector(el) {
        if (el.id) return '#' + el.id;
        var tag = (el.tagName || '').toLowerCase();
        if (el.className && typeof el.className === 'string') {
          var cls = el.className.trim().split(/\\s+/).filter(function(c){ return c; })[0];
          if (cls) return tag + '.' + cls;
        }
        if (el.getAttribute && el.getAttribute('name')) return tag + '[name="' + el.getAttribute('name') + '"]';
        var text = (el.textContent || '').trim().substring(0, 20);
        return text ? tag + ':has-text("' + text + '")' : tag;
      }
      function isClickableBtn(el) {
        if (!el || !el.tagName) return false;
        var tag = el.tagName.toLowerCase();
        if (tag === 'button' && el.type !== 'button') return true;
        if (tag === 'input' && (el.type === 'submit' || el.type === 'image')) return true;
        if (tag === 'a' && el.href && el.href.indexOf('javascript:') === 0) return true;
        if (el.getAttribute && el.getAttribute('role') === 'button') return true;
        if (el.classList && (el.classList.contains('nextBtn') || el.classList.contains('nextBtn2'))) return true;
        // テキストマッチは button/a のみ（div/span などの大きなコンテナは除外して誤検出を防ぐ）
        if (tag === 'button' || tag === 'a') {
          var text = (el.textContent || '').toLowerCase();
          return /次へ|進む|送信|確認|完了|登録|スタート|開始|診断|申込|submit|next|confirm|start/.test(text);
        }
        return false;
      }
      document.addEventListener('click', function(e) {
        var el = e.target;
        for (var i = 0; i < 5 && el; i++) {
          if (isClickableBtn(el)) {
            var info = { selector: buildClickSelector(el), text: (el.textContent || '').trim().substring(0, 30) };
            window.__lastClickedSubmit = info;
            console.log('__SUBMIT_CLICK__' + JSON.stringify(info));
            setTimeout(function() {
              if (typeof window.__fieldWatcherCallback === 'function') window.__fieldWatcherCallback();
            }, 1000);
            break;
          }
          el = el.parentElement;
        }
      }, true);
    })()`);

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

    // ①対応: console.log経由でボタンクリックをページ遷移前に捕捉
    this.page.on('console', (msg) => {
      if (!this.recording) return;
      const text = msg.text();
      if (text.startsWith('__SUBMIT_CLICK__')) {
        try {
          const data = JSON.parse(text.slice('__SUBMIT_CLICK__'.length));
          this._pendingClickedSubmit = data;
          this.log('info', `🖱️ ボタンクリック事前検知: ${data.selector} "${data.text}"`);
        } catch {}
      }
    });

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
    if (!this.page.isClosed()) {
      this.send({
        type: 'browser:navigated',
        payload: { url: this.page.url(), title: await this.page.title().catch(() => '') },
      });
    }

    this.log('info', '📹 記録開始 — ログイン画面を含めて全操作を手動で行ってください');
  }

  private async autoCollectFields(): Promise<void> {
    if (!this.page || !this.recording || this.page.isClosed()) return;

    // 並行実行防止: 収集中なら1回だけキューして終了
    if (this._collecting) {
      this._pendingCollect = true;
      return;
    }
    this._collecting = true;
    this._pendingCollect = false;

    try {
      await this._doCollect();
    } finally {
      this._collecting = false;
      if (this._pendingCollect) {
        this._pendingCollect = false;
        // キューされた1回を実行（遅延して再収集）
        setTimeout(() => this.autoCollectFields(), 300);
      }
    }
  }

  private async _doCollect(): Promise<void> {
    if (!this.page || !this.recording || this.page.isClosed()) return;

    // URLをasync処理前に即座に取得（遷移中に変わらないように）
    const capturedUrl = this.page.url();

    try {
      // クリックされたボタン情報を取得
      // ①優先: console.log経由で事前に受け取った情報（ページ遷移後でも残る）
      // ②フォールバック: ページのwindow変数から取得（同一ページ内遷移用）
      let clickedSubmit: { selector: string; text: string } | null = this._pendingClickedSubmit;
      this._pendingClickedSubmit = null;
      if (!clickedSubmit) {
        try {
          clickedSubmit = await this.page.evaluate(() => {
            const info = (window as any).__lastClickedSubmit;
            (window as any).__lastClickedSubmit = null;
            return info || null;
          });
        } catch { /* ページ遷移中は無視 */ }
      }

      // クリックの分類: 同じURLならpreClick、異なるURL(ナビゲーション)ならsubmitSelector
      const prevPage = this.session.pages.length > 0
        ? this.session.pages[this.session.pages.length - 1]
        : null;
      if (clickedSubmit && prevPage) {
        if (prevPage.url !== capturedUrl) {
          // ナビゲーション後 → 前ページのsubmitSelectorとして記録
          prevPage.submitSelector = clickedSubmit.selector;
          prevPage.submitText = clickedSubmit.text;
          this.log('info', `🎯 submitSelector記録: ${clickedSubmit.selector} "${clickedSubmit.text}"`);
          this.send({
            type: 'recording:submit-detected',
            payload: { pageId: prevPage.id, submitSelector: clickedSubmit.selector, submitText: clickedSubmit.text },
          });
          clickedSubmit = null; // 処理済みとしてクリア
        }
        // 同じURLの場合はURLdedup処理で preClicks に追加するので、ここでは何もしない
      }

      await this.page.waitForLoadState('domcontentloaded');
      
      // 動的フィールド対応: ページ読み込み後、追加の待機
      // JSフレームワーク（React/Vue等）のレンダリング完了を待つ
      await new Promise(r => setTimeout(r, 1000));
      
      // networkidleも待つ（APIリクエスト完了待ち）
      await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      
      // さらに少し待って、遅延レンダリングに対応
      await new Promise(r => setTimeout(r, 500));

      const url = capturedUrl;
      const title = await this.page.title().catch(() => '');

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
      
      // 常に追加待機して再収集（動的フィールド対応）
      const retryDelay = this.settings.timeout?.fieldCollectRetryDelay ?? 2000;
      await new Promise(r => setTimeout(r, retryDelay));
      const retryFields = await collectPageFields(this.page);
      if (retryFields.length > fields.length) {
        this.log('info', `🔄 追加フィールドを検出: ${fields.length} → ${retryFields.length}`);
        fields = retryFields;
      } else if (retryFields.length === fields.length) {
        // 同数でも内容が変わっている可能性があるのでマージ
        const existingSelectors = new Set(fields.map(f => f.selector));
        for (const f of retryFields) {
          if (!existingSelectors.has(f.selector)) {
            fields.push(f);
          }
        }
      }
      
      // 同一URLの場合は既存ページを更新（モーダル閉じ後の再collectで重複しないように）
      const lastPage = this.session.pages.length > 0
        ? this.session.pages[this.session.pages.length - 1]
        : null;
      if (lastPage && lastPage.url === url) {
        // 同一URL内でのボタンクリック（モーダル閉じなど）→ preClicks として記録
        if (clickedSubmit) {
          if (!lastPage.preClicks) lastPage.preClicks = [];
          lastPage.preClicks.push({ selector: clickedSubmit.selector, text: clickedSubmit.text });
          this.log('info', `🖱️ preClick記録: ${clickedSubmit.selector} "${clickedSubmit.text}"`);
          this.send({
            type: 'recording:submit-detected',
            payload: { pageId: lastPage.id, submitSelector: `[preClick] ${clickedSubmit.text}`, submitText: clickedSubmit.text },
          });
        }
        // フィールドをマージ（既存に含まれないものだけ追加）
        const existingSels = new Set(lastPage.fields.map((f: any) => f.selector));
        const newFields = fields.filter((f: any) => !existingSels.has(f.selector));
        if (newFields.length > 0) {
          lastPage.fields.push(...newFields);
          this.log('info', `🔄 同一URL: ${newFields.length}個の新フィールドをマージ`);
          this.send({ type: 'fields:collected', payload: { pageId: lastPage.id, fields: lastPage.fields } });
        }
        return;
      }

      // フィールドが0件 かつ ボタンクリックも無し → 記録不要
      if (fields.length === 0 && !clickedSubmit) return;

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

      // Case 3: 最初のページでモーダルボタンクリックが先に発生していた場合
      // lastPageが存在しないためsubmitSelectorに使われなかったclickedSubmitをpreClicksとして保存
      if (clickedSubmit && this.session.pages.length === 0) {
        recordedPage.preClicks = [{ selector: clickedSubmit.selector, text: clickedSubmit.text }];
        this.log('info', `🖱️ 初回ページのpreClickを記録: ${clickedSubmit.selector} "${clickedSubmit.text}"`);
      }

      // 送信ボタン検出（javascript:リンク対応強化）
      const submitInfo = await this.page.evaluate(() => {
        // 日本語保険サイト対応のテキストパターン
        const textPattern = /次へ|進む|送信|確認|完了|登録|保存|スタート|開始|診断|申込|見積|ログイン|サインイン|submit|next|confirm|save|start|login|sign.?in/i;
        
        const candidates: HTMLElement[] = [
          // 1. type="submit" ボタン
          ...Array.from(document.querySelectorAll('button[type="submit"]')) as HTMLElement[],
          ...Array.from(document.querySelectorAll('input[type="submit"]')) as HTMLElement[],
          // 2. input[type="image"] 画像ボタン
          ...Array.from(document.querySelectorAll('input[type="image"]')) as HTMLElement[],
          // 3. javascript: リンク（全労済などで使用）
          ...Array.from(document.querySelectorAll('a[href^="javascript:"]')).filter((a: Element) => {
            const el = a as HTMLElement;
            return el.offsetParent !== null && textPattern.test(el.textContent || '');
          }) as HTMLElement[],
          // 4. nextBtn/nextBtn2 クラス（全労済パターン）
          ...Array.from(document.querySelectorAll('a.nextBtn, a.nextBtn2')) as HTMLElement[],
          // 5. role="button" ARIAボタン
          ...Array.from(document.querySelectorAll('[role="button"]')).filter((b: Element) => {
            const el = b as HTMLElement;
            return el.offsetParent !== null && textPattern.test(el.textContent || '');
          }) as HTMLElement[],
          // 6. div/span[onclick] カスタムクリック要素
          ...Array.from(document.querySelectorAll('div[onclick], span[onclick]')).filter((b: Element) => {
            const el = b as HTMLElement;
            return el.offsetParent !== null && textPattern.test(el.textContent || '');
          }) as HTMLElement[],
          // 7. テキストマッチのボタン
          ...Array.from(document.querySelectorAll('button')).filter((b: Element) => {
            const el = b as HTMLElement;
            return el.offsetParent !== null && textPattern.test(el.textContent || '');
          }) as HTMLElement[],
          // 8. テキストマッチのリンク
          ...Array.from(document.querySelectorAll('a')).filter((a: Element) => {
            const el = a as HTMLElement;
            return el.offsetParent !== null && textPattern.test(el.textContent || '');
          }) as HTMLElement[],
        ];
        
        // 重複削除
        const seen = new Set<HTMLElement>();
        const uniqueCandidates = candidates.filter(el => {
          if (seen.has(el)) return false;
          seen.add(el);
          return true;
        });
        
        if (uniqueCandidates.length === 0) return null;
        const el = uniqueCandidates[0];
        const tagName = el.tagName.toLowerCase();
        
        let selector = '';
        if (el.id) {
          selector = `#${el.id}`;
        } else if (el.className && typeof el.className === 'string') {
          // クラス名からセレクタを構築（複数クラスの場合は最初のものを使用）
          const className = el.className.trim().split(/\s+/)[0];
          if (className) {
            selector = `${tagName}.${className}`;
          }
        }
        if (!selector && el.getAttribute('name')) {
          selector = `${tagName}[name="${el.getAttribute('name')}"]`;
        }
        if (!selector && el.getAttribute('type') === 'submit') {
          selector = `${tagName}[type="submit"]`;
        }
        if (!selector) {
          const text = el.textContent?.trim().substring(0, 20) || '';
          selector = `${tagName}:has-text("${text}")`;
        }
        
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

  async detectSubmitButton(): Promise<{ submitSelector: string; submitText: string }> {
    if (!this.page || this.page.isClosed()) return { submitSelector: '', submitText: '' };
    try {
      const result = await this.page.evaluate(() => {
        const textPattern = /次へ|進む|送信|確認|完了|登録|保存|スタート|開始|診断|申込|見積|ログイン|サインイン|submit|next|confirm|save|start|login/i;
        // ※ アロー関数ではなく function宣言を使用（tsx/esbuildの__name注入を回避）
        function buildSel(el) {
          if (el.id) return '#' + el.id;
          const tag = el.tagName.toLowerCase();
          if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\s+/).filter(Boolean);
            if (cls.length) return tag + '.' + cls.join('.');
          }
          if (el.getAttribute('name')) return tag + '[name="' + el.getAttribute('name') + '"]';
          const text = (el.textContent || '').trim().slice(0, 20);
          return text ? tag + ':has-text("' + text + '")' : tag;
        }
        const candidates: HTMLElement[] = [
          ...Array.from(document.querySelectorAll('input[type="submit"], input[type="image"], button[type="submit"]')) as HTMLElement[],
          ...Array.from(document.querySelectorAll('a[href^="javascript:"], a.nextBtn, a.nextBtn2')) as HTMLElement[],
          ...Array.from(document.querySelectorAll('button, a, [role="button"], div[onclick], span[onclick], input[type="button"]')).filter((el: Element) => {
            const e = el as HTMLElement;
            const style = window.getComputedStyle(e);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            return textPattern.test(e.textContent || '');
          }) as HTMLElement[],
        ];
        const seen = new Set<HTMLElement>();
        for (const el of candidates) {
          if (seen.has(el)) continue;
          seen.add(el);
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          return { submitSelector: buildSel(el), submitText: el.textContent?.trim().slice(0, 30) || '' };
        }
        return { submitSelector: '', submitText: '' };
      });
      if (result.submitSelector) {
        this.log('info', `🔍 送信ボタン自動検出: ${result.submitSelector} "${result.submitText}"`);
      } else {
        this.log('warn', '🔍 送信ボタンが見つかりませんでした');
      }
      return result;
    } catch (e: any) {
      this.log('warn', `送信ボタン検出エラー: ${e.message}`);
      return { submitSelector: '', submitText: '' };
    }
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

  // ===== スクリーンショットヘルパー =====
  // fullPage: true を試みてタイムアウトしたらフォールバック。ログも出す。
  private async takeScreenshot(
    page: import('playwright').Page,
    filePath: string,
    label: string,
    screenshots: string[],
  ): Promise<void> {
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    this.log('info', `📸 撮影中 [${label}]: ${name}`);
    try {
      // フォント読み込みを最大3秒待つ（タイムアウトしても続行）
      await page.evaluate(() =>
        Promise.race([
          (document as any).fonts?.ready ?? Promise.resolve(),
          new Promise(r => setTimeout(r, 3000)),
        ])
      ).catch(() => {});

      // fullPage: true でフル画面取得（15秒以内）
      await page.screenshot({ path: filePath, fullPage: true, timeout: 15000 });
      const size = (() => { try { return require('fs').statSync(filePath).size; } catch { return 0; } })();
      this.log('info', `📸 ✅ 完了 [${label}]: ${name} (${Math.round(size / 1024)}KB)`);
      screenshots.push(filePath.replace(/\\/g, '/'));
    } catch (err: any) {
      // フォールバック: viewport のみ（高速・確実）
      this.log('warn', `📸 ⚠️ フルページ失敗 → viewport撮影にフォールバック [${label}]: ${err.message}`);
      try {
        await page.screenshot({ path: filePath, fullPage: false, timeout: 8000 });
        const size = (() => { try { return require('fs').statSync(filePath).size; } catch { return 0; } })();
        this.log('info', `📸 ✅ 完了（viewport）[${label}]: ${name} (${Math.round(size / 1024)}KB)`);
        screenshots.push(filePath.replace(/\\/g, '/'));
      } catch (e2: any) {
        this.log('warn', `📸 ❌ スクリーンショット失敗 [${label}]: ${e2.message}`);
      }
    }
  }

  // ===== 再生モード =====
  // ログイン画面もステップ1として扱う。全画面同じロジックで入力→送信を繰り返す。

  // 通常モード用ラッパー（単一セッション）
  async startReplay(session: RecordingSession, testCases: TestCase[]): Promise<void> {
    const enabledCases = testCases.filter(c => c.enabled);
    await this.startReplaySuite(enabledCases.map(tc => ({ session, testCase: tc })));
  }

  // マージモード用: 複数セッションのテストケースを実行
  async startReplaySuite(items: { session: RecordingSession; testCase: TestCase }[]): Promise<void> {
    const inputHandler = new InputHandler();
    const results: ReplayResult[] = [];

    this.log('info', `${items.length}件のテストケースを実行します`);

    for (const { session, testCase } of items) {
      const startTime = Date.now();
      const screenshotDir = path.resolve('data/screenshots', `${testCase.caseId}_${timestamp()}`);
      fs.mkdirSync(screenshotDir, { recursive: true });
      const screenshots: string[] = [];
      let ssSeq = 0;  // スクリーンショット通番
      const nextSsPath = () => path.join(screenshotDir, `${testCase.caseId}_${String(++ssSeq).padStart(3, '0')}.png`);

      // ケース開始を通知（ブラウザ起動前）
      this.send({
        type: 'replay:progress',
        payload: {
          caseId: testCase.caseId,
          step: 0,
          total: testCase.pageInputs.length,
          status: `🚀 ブラウザ起動中...`,
        },
      });
      this.log('info', `[${testCase.caseId}] 🚀 ケース開始: ${testCase.caseName}`);

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

        this.send({
          type: 'replay:progress',
          payload: {
            caseId: testCase.caseId,
            step: 0,
            total: testCase.pageInputs.length,
            status: `🌐 開始URLへ移動中...`,
          },
        });
        this.log('info', `[${testCase.caseId}] 🌐 開始URLへ移動: ${startUrl}`);

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

          // preClicks: モーダル閉じなど事前クリックが必要な場合に実行
          const preClicks = sessionPage?.preClicks;
          if (preClicks && preClicks.length > 0) {
            this.log('info', `[${testCase.caseId}] 🖱️ preClicks実行: ${preClicks.length}件`);
            for (const preClick of preClicks) {
              try {
                this.log('info', `[${testCase.caseId}] 🖱️ preClick: ${preClick.selector} "${preClick.text}"`);
                // JS直接クリック（modalオーバーレイに阻まれないよう）
                const clicked = await page.evaluate((sel) => {
                  const el = document.querySelector(sel);
                  if (el) { (el as HTMLElement).click(); return true; }
                  return false;
                }, preClick.selector).catch(() => false);
                if (!clicked) {
                  // フォールバック: force click
                  await page.locator(preClick.selector).first().click({ force: true, timeout: 3000 }).catch(() => {});
                }
                await page.waitForTimeout(800);
                await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
              } catch (e: any) {
                this.log('warn', `[${testCase.caseId}] ⚠️ preClickエラー: ${preClick.selector} - ${e.message}`);
              }
            }
          }

          // 入力前キャプチャ
          await this.takeScreenshot(page, nextSsPath(), `${testCase.caseId} step${pageInput.stepNumber} before`, screenshots);

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
              const afterInputDelay = this.settings.timeout?.afterInputDelay ?? 200;
              await page.waitForTimeout(afterInputDelay);
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

          // 入力後キャプチャ（CSSアニメーション/トランジション完了待ち）
          const screenshotDelay = this.settings.timeout?.screenshotDelay ?? 500;
          await page.waitForTimeout(screenshotDelay);

          await this.takeScreenshot(page, nextSsPath(), `${testCase.caseId} step${pageInput.stepNumber} after`, screenshots);

          // 送信ボタンクリック → 次画面へ遷移
          let submitSelector = pageInput.submitSelector || sessionPage?.submitSelector;

          // submitSelector が空の場合、自動検出を試みる
          if (!submitSelector) {
            this.log('info', `[${testCase.caseId}] 🔍 送信ボタンを自動検出中...`);
            
            // デバッグ: ページ内のボタン候補を列挙
            const debugInfo = await page.evaluate(() => {
              const results: string[] = [];
              
              // javascript: リンクをチェック
              const jsLinks = document.querySelectorAll('a[href^="javascript:"]');
              results.push(`javascript:リンク数: ${jsLinks.length}`);
              jsLinks.forEach((a, i) => {
                const el = a as HTMLElement;
                const text = el.textContent?.trim().substring(0, 30) || '';
                const visible = el.offsetParent !== null;
                const classes = el.className || '';
                results.push(`  [${i}] text="${text}" visible=${visible} class="${classes}"`);
              });
              
              // nextBtn/nextBtn2 をチェック
              const nextBtns = document.querySelectorAll('a.nextBtn, a.nextBtn2');
              results.push(`nextBtn/nextBtn2数: ${nextBtns.length}`);
              nextBtns.forEach((a, i) => {
                const el = a as HTMLElement;
                const text = el.textContent?.trim().substring(0, 30) || '';
                const visible = el.offsetParent !== null;
                results.push(`  [${i}] text="${text}" visible=${visible}`);
              });
              
              return results.join('\n');
            });
            appendLog('debug', `[${testCase.caseId}] ボタン候補:\n${debugInfo}`);
            
            const autoDetected = await page.evaluate(() => {
              // 優先度順に検索（セレクタパターン）
              const patterns = [
                'button[type="submit"]:not([disabled])',
                'input[type="submit"]:not([disabled])',
                'input[type="image"]',  // 画像ボタン
                'a[href^="javascript:"]',  // disabled チェック削除（aタグには通常ない）
                'a.nextBtn',
                'a.nextBtn2',
                '[role="button"]',  // ARIAボタン
                'div[onclick]',     // カスタムクリック要素
                'span[onclick]',    // カスタムクリック要素
                'button.btn-primary:not([disabled])',
                'button.submit:not([disabled])',
                'a.btn-primary',
                'a.btn-submit',
                '.btn-start',
                '.submit-btn',
              ];
              // テキストパターン（日本語保険サイト対応を強化）
              const textPatterns = [
                '次へ', '進む', '確認', '送信', '完了', '登録', '保存',
                'スタート', '診断', '開始', '申込', '見積',
                'next', 'submit', 'confirm', 'start'
              ];

              for (const pattern of patterns) {
                const el = document.querySelector(pattern) as HTMLElement | null;
                // offsetParent チェックを緩和（fixedやabsoluteでもnullになることがある）
                if (el) {
                  const style = window.getComputedStyle(el);
                  const isHidden = style.display === 'none' || style.visibility === 'hidden';
                  if (!isHidden) {
                    const id = el.id ? `#${el.id}` : null;
                    const className = el.className && typeof el.className === 'string' 
                      ? `.${el.className.trim().split(/\s+/)[0]}` 
                      : null;
                    const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : null;
                    return id || className || name || pattern;
                  }
                }
              }

              // テキストマッチで検索（button, a, input, div等を広く検索）
              const allClickables = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')) as HTMLElement[];
              for (const btn of allClickables) {
                // 表示チェックを緩和
                const style = window.getComputedStyle(btn);
                const isHidden = style.display === 'none' || style.visibility === 'hidden';
                if (isHidden) continue;
                
                const text = btn.textContent?.trim() || '';
                const value = (btn as HTMLInputElement).value || '';
                const combined = (text + ' ' + value).toLowerCase();
                for (const keyword of textPatterns) {
                  if (combined.includes(keyword.toLowerCase())) {
                    const id = btn.id ? `#${btn.id}` : null;
                    const className = btn.className && typeof btn.className === 'string'
                      ? `.${btn.className.trim().split(/\s+/)[0]}`
                      : null;
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

          // 次のステップが同じURLなら送信しない（同一ページの動的フィールドを続けて入力するため）
          const nextPageInput = sortedInputs[i + 1];
          const nextSessionPage = nextPageInput
            ? session.pages.find(p => p.stepNumber === nextPageInput.stepNumber)
            : null;
          const currentStepUrl = sessionPage?.url || '';
          const nextStepUrl = nextSessionPage?.url || '';
          // ファイル名で比較（ticketパラメータの違いを無視）
          const urlFile = (u: string) => u.split('?')[0].split('/').filter(Boolean).pop() || '';
          const isSamePageNext = !!(nextStepUrl && currentStepUrl &&
            urlFile(nextStepUrl) === urlFile(currentStepUrl));

          if (isSamePageNext) {
            this.log('info', `[${testCase.caseId}] ⏭ 次のステップも同じページ → 送信スキップして続けて入力`);
          } else if (submitSelector) {
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
                  // スタック時スクリーンショット
                  await this.takeScreenshot(page, nextSsPath(), `${testCase.caseId} step${pageInput.stepNumber} stuck`, screenshots);
                }
              }
            } catch (err: any) {
              this.log('warn', `[${testCase.caseId}] 遷移エラー: ${err.message}`);
            }
          }
        }

        // 最終画面キャプチャ
        const finalScreenshotDelay = this.settings.timeout?.screenshotDelay ?? 500;
        await page.waitForTimeout(finalScreenshotDelay);

        await this.takeScreenshot(page, nextSsPath(), `${testCase.caseId} final`, screenshots);

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
