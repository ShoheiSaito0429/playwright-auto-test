import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { fileURLToPath } from 'url';
import type { RecordingSession, RecordedPage, Settings, TestCase, ReplayResult, WSMessage, ClickEvent } from '../types.js';
import { collectPageFields, installFieldWatcher } from './field-collector.js';
import { InputHandler } from './input-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));
const VERSION = packageJson.version;

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
  // クリックイベント記録ファイルパス（記録中のみ使用）
  private eventsFilePath: string = '';
  // autoCollectFields の並行実行防止フラグ
  private _collecting = false;
  private _pendingCollect = false;
  // replay中止フラグ
  private _replayAborted = false;

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
      args: ['--remote-debugging-port=9222'],
    });
    this.context = await this.browser.newContext({
      viewport: this.settings.browser.viewport,
    });

    // ページロード前から全クリックをキャプチャ（モーダル内ボタンも漏らさない）
    await this.context.addInitScript(`(function() {
      function buildClickSelector(el) {
        if (!el) return '';
        var tag = (el.tagName || '').toLowerCase();

        // 1. id が最も確実
        if (el.id) return '#' + el.id;

        // 2. href が固有な場合（javascript: リンクや固有パスは識別子として最強）
        var href = el.getAttribute ? (el.getAttribute('href') || '') : '';
        if (href && href !== '#' && href !== 'javascript:void(0)' && href !== 'javascript:;') {
          return tag + '[href="' + href + '"]';
        }

        var text = ((el.textContent || '')).trim().replace(/\\s+/g, ' ').substring(0, 30);
        var classes = (el.className && typeof el.className === 'string')
          ? el.className.trim().split(/\\s+/).filter(function(c){ return c; })
          : [];

        // 3. クラス + テキスト の組み合わせ（クラス単独より確実）
        if (classes.length && text) {
          return tag + '.' + classes.join('.') + ':has-text("' + text + '")';
        }

        // 4. テキストのみ
        if (text) return tag + ':has-text("' + text + '")';

        // 5. クラスのみ（最終手段）
        if (classes.length) return tag + '.' + classes.join('.');

        if (el.getAttribute && el.getAttribute('name')) return tag + '[name="' + el.getAttribute('name') + '"]';
        return tag;
      }
      function isClickableElement(el) {
        if (!el || !el.tagName) return false;
        var tag = el.tagName.toLowerCase();
        if (tag === 'a') return true;
        if (tag === 'button') return true;
        if (tag === 'input' && (el.type === 'submit' || el.type === 'button' || el.type === 'image')) return true;
        if (el.getAttribute && el.getAttribute('role') === 'button') return true;
        if (el.hasAttribute && el.hasAttribute('onclick')) return true;
        return false;
      }
      document.addEventListener('click', function(e) {
        var el = e.target;
        for (var i = 0; i < 5 && el; i++) {
          if (isClickableElement(el)) {
            var info = {
              ts: Date.now(),
              url: window.location.href,
              selector: buildClickSelector(el),
              text: ((el.textContent || '') + (el.value || '')).trim().substring(0, 50),
              tag: el.tagName.toLowerCase(),
            };
            console.log('__CLICK_EVENT__' + JSON.stringify(info));
            setTimeout(function() {
              if (typeof window.__fieldWatcherCallback === 'function') window.__fieldWatcherCallback();
            }, 500);
            break;
          }
          el = el.parentElement;
        }
      }, true);
    })()`);

    this.page = await this.context.newPage();
    this.recording = true;
    this.stepCounter = 0;

    const sessionId = uuid();
    const sessionName = `recording_${timestamp()}`;

    // クリックイベント記録ファイルを初期化
    const eventsDir = path.resolve('data/events');
    fs.mkdirSync(eventsDir, { recursive: true });
    this.eventsFilePath = path.join(eventsDir, `${sessionName}_clicks.jsonl`);
    fs.writeFileSync(this.eventsFilePath, '', 'utf-8'); // 空ファイルで初期化

    this.session = {
      id: sessionId,
      name: sessionName,
      startUrl,
      pages: [],
      startedAt: new Date().toISOString(),
      completedAt: '',
    };

    // 全クリックイベントをファイルに記録
    this.page.on('console', (msg) => {
      if (!this.recording) return;
      const text = msg.text();
      if (text.startsWith('__CLICK_EVENT__')) {
        try {
          const data: ClickEvent = JSON.parse(text.slice('__CLICK_EVENT__'.length));
          fs.appendFileSync(this.eventsFilePath, JSON.stringify(data) + '\n', 'utf-8');
          this.log('info', `🖱️ クリック記録: ${data.selector} "${data.text}"`);
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
      // ナビゲーション発生時刻をJSONLに即記録（autoCollect完了前に確定させる）
      // → enrichPagesWithClickEventsでクリックの正確なページ境界として使用
      if (this.eventsFilePath) {
        const navEvent = { type: 'navigate', ts: Date.now(), url: this.page.url(), selector: '', text: '', tag: '' };
        try { fs.appendFileSync(this.eventsFilePath, JSON.stringify(navEvent) + '\n', 'utf-8'); } catch {}
      }
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

    this.log('info', `━━━ Playwright Auto Test v${VERSION} ━━━`);
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

    // 収集開始: GUIとブラウザ両方に通知
    this.send({ type: 'collecting:start', payload: {} });
    if (this.page && !this.page.isClosed()) {
      this.page.evaluate(() => {
        if (!document.getElementById('__pw_collecting')) {
          const el = document.createElement('div');
          el.id = '__pw_collecting';
          el.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:rgba(99,102,241,0.92);color:#fff;padding:8px 16px;border-radius:8px;font-size:14px;font-family:sans-serif;font-weight:600;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,0.3);';
          el.textContent = '🔄 フィールド収集中...';
          document.body.appendChild(el);
        }
      }).catch(() => {});
    }

    try {
      await this._doCollect();
    } finally {
      this._collecting = false;
      // 収集終了: GUIとブラウザ両方から削除
      this.send({ type: 'collecting:end', payload: {} });
      if (this.page && !this.page.isClosed()) {
        this.page.evaluate(() => {
          document.getElementById('__pw_collecting')?.remove();
        }).catch(() => {});
      }

      if (this._pendingCollect) {
        this._pendingCollect = false;
        // キューされた1回を実行（遅延して再収集）
        setTimeout(() => this.autoCollectFields(), 300);
      }
    }
  }

  private async _doCollect(): Promise<void> {
    if (!this.page || !this.recording || this.page.isClosed()) return;

    const capturedUrl = this.page.url();

    try {
      await this.page.waitForLoadState('domcontentloaded');
      await new Promise(r => setTimeout(r, 1000));
      await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));

      const url = capturedUrl;
      const title = await this.page.title().catch(() => '');

      this.send({ type: 'browser:navigated', payload: { url, title } });

      // ページ遷移後にMutationObserverを再注入
      try {
        await installFieldWatcher(this.page, () => {
          this.log('info', '🔄 フィールド状態の変化を検知 → 再収集中...');
          this.autoCollectFields();
        });
      } catch { /* 既に注入済みの場合は無視 */ }

      // フィールド収集（初回 + リトライ）
      let fields = await collectPageFields(this.page);
      const retryDelay = this.settings.timeout?.fieldCollectRetryDelay ?? 2000;
      await new Promise(r => setTimeout(r, retryDelay));
      const retryFields = await collectPageFields(this.page);
      if (retryFields.length > fields.length) {
        this.log('info', `🔄 追加フィールドを検出: ${fields.length} → ${retryFields.length}`);
        fields = retryFields;
      } else {
        const existingSelectors = new Set(fields.map(f => f.selector));
        for (const f of retryFields) {
          if (!existingSelectors.has(f.selector)) fields.push(f);
        }
      }

      // 同一URLの場合はフィールドをマージ（値・状態も更新）
      // URLのパス部分のみで比較（ticketなどクエリパラメーターが変わるサイト対応）
      const getPathname = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };
      const lastPage = this.session!.pages.length > 0
        ? this.session!.pages[this.session!.pages.length - 1]
        : null;
      if (lastPage && getPathname(lastPage.url) === getPathname(url)) {
        let updated = false;
        for (const newField of fields) {
          const existing = lastPage.fields.find((f: any) => f.selector === newField.selector);
          if (existing) {
            // 既存フィールドのvalue/checked/stateを更新（ユーザー入力値を反映）
            if (existing.value !== newField.value || existing.checked !== newField.checked) {
              existing.value = newField.value;
              existing.checked = newField.checked;
              existing.state = newField.state;
              updated = true;
            }
          } else {
            // 新フィールドを追加
            lastPage.fields.push(newField);
            updated = true;
          }
        }
        if (updated) {
          lastPage.recordedAtMs = Date.now();
          this.log('info', `🔄 同一URL: フィールド値を更新`);
          this.send({ type: 'recording:page-collected', payload: lastPage });
        }
        return;
      }

      // フィールドが0件 → 記録不要
      if (fields.length === 0) return;

      this.stepCounter++;
      const pageId = uuid();
      const nowMs = Date.now();

      const recordedPage: RecordedPage = {
        id: pageId,
        url,
        title,
        stepNumber: this.stepCounter,
        fields,
        recordedAt: new Date().toISOString(),
        recordedAtMs: nowMs,
      };

      this.session!.pages.push(recordedPage);

      this.send({ type: 'recording:page-collected', payload: recordedPage });
      this.send({ type: 'fields:collected', payload: { pageId, fields } });

      this.log('info', `ステップ${this.stepCounter}: ${fields.length}個のフィールドを検出 (${title})`);
      this.log('info', `  └ URL: ${url.substring(0, 80)}${url.length > 80 ? '...' : ''}`);
      this.log('info', `  └ セッション内ページ数: ${this.session!.pages.length}`);
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

  async stopRecording(dropLastPage = false): Promise<RecordingSession | null> {
    if (!this.session) return null;
    this.recording = false;

    if (dropLastPage && this.session.pages.length > 0) {
      const removed = this.session.pages.pop();
      this.log('info', `🗑️ 最後のページを除外: ${removed?.url}`);
    }

    this.session.completedAt = new Date().toISOString();

    // 記録終了時に現在のフィールド値を最終キャプチャ（hidden→visible後の値を拾う）
    if (this.page && !this.page.isClosed() && this.session.pages.length > 0) {
      try {
        const { collectPageFields } = await import('./field-collector.js');
        const finalFields = await collectPageFields(this.page);
        const lastPage = this.session.pages[this.session.pages.length - 1];
        let updated = false;
        for (const newField of finalFields) {
          const existing = lastPage.fields.find((f: any) => f.selector === newField.selector);
          if (existing) {
            if (existing.value !== newField.value || existing.checked !== newField.checked) {
              existing.value = newField.value;
              existing.checked = newField.checked;
              existing.state = newField.state;
              existing.isVisible = newField.isVisible;
              updated = true;
            }
          } else if (newField.isVisible) {
            lastPage.fields.push(newField);
            updated = true;
          }
        }
        if (updated) this.log('info', '✅ 記録終了時に最終フィールド値を更新');
      } catch (e: any) {
        this.log('warn', `最終フィールド値取得エラー: ${e.message}`);
      }
    }

    // クリックイベントを照合してpreClick/submitSelectorを自動整合
    this.enrichPagesWithClickEvents();

    // 詳細ログ出力
    this.log('info', `━━━ 記録サマリー ━━━`);
    this.log('info', `📊 合計ページ数: ${this.session.pages.length}`);
    for (const page of this.session.pages) {
      const preClickCount = page.preClicks?.length ?? 0;
      const fieldCount = page.fields?.length ?? 0;
      this.log('info', `  ステップ${page.stepNumber}: ${fieldCount}フィールド, ${preClickCount}preClicks, submit="${page.submitText || 'なし'}"`);
      for (const pc of (page.preClicks ?? [])) {
        this.log('info', `    └ preClick: "${pc.text}" (${pc.selector})`);
      }
    }
    this.log('info', `━━━━━━━━━━━━━━━━━━`);

    const dir = path.resolve('data/recordings');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${this.session.name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(this.session, null, 2), 'utf-8');

    this.log('info', `✅ 記録を保存しました: ${filePath}`);
    this.send({ type: 'recording:complete', payload: this.session });

    await this.cleanup();
    return this.session;
  }

  /**
   * クリックイベントファイルを読み取り、各ページのpreClick/submitSelectorを自動整合
   * 「ボタン押下→モーダル表示→モーダル押下→遷移」のような複雑なフローに対応
   */
  private enrichPagesWithClickEvents(): void {
    if (!this.eventsFilePath || !fs.existsSync(this.eventsFilePath)) {
      this.log('warn', 'クリックイベントファイルが見つかりません');
      return;
    }

    let allEvents: ClickEvent[] = [];
    try {
      const lines = fs.readFileSync(this.eventsFilePath, 'utf-8').split('\n').filter(Boolean);
      allEvents = lines
        .map(l => { try { return JSON.parse(l) as ClickEvent; } catch { return null; } })
        .filter((e): e is ClickEvent => e !== null);
    } catch (e: any) {
      this.log('warn', `クリックイベント読み取りエラー: ${e.message}`);
      return;
    }

    // navigate イベントとclick イベントに分離
    const navigateEvents = allEvents.filter(e => e.type === 'navigate').sort((a, b) => a.ts - b.ts);
    const rawClickEvents = allEvents.filter(e => !e.type || e.type === 'click').sort((a, b) => a.ts - b.ts);

    // 重複排除: addInitScript と install-watcher の両方がリスナーを持つため
    // 同一セレクタが100ms以内に連続で記録される → 1件に統合
    const clickEvents: ClickEvent[] = [];
    for (const e of rawClickEvents) {
      const last = clickEvents[clickEvents.length - 1];
      if (last && last.selector === e.selector && e.ts - last.ts < 100) continue;
      clickEvents.push(e);
    }

    this.log('info', `📊 クリックイベント総数: ${clickEvents.length} (ナビゲートイベント: ${navigateEvents.length}件)`);
    if (clickEvents.length === 0) return;

    // ページをstepNumber順にソート
    const sortedPages = [...this.session!.pages].sort((a, b) => a.stepNumber - b.stepNumber);

    // URL パス取得ヘルパー
    const getPath = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };

    if (navigateEvents.length > 0) {
      // ===== ナビゲートイベント方式（精度高） =====
      // navigateイベントをウィンドウとして使い、各ページに対応するウィンドウを特定する
      // ウィンドウ[nav_i, nav_{i+1})にあるクリック = nav_i.urlのページでのクリック
      //   → 最後のクリック = そのページのsubmitSelector（次ページへ遷移したボタン）
      //   → それ以前 = preClicks（モーダルを開く等の事前操作）

      // URL別ページ一覧（同じURLが複数ある場合に順番で対応）
      const pagesByPath = new Map<string, RecordedPage[]>();
      for (const page of sortedPages) {
        const path = getPath(page.url);
        if (!pagesByPath.has(path)) pagesByPath.set(path, []);
        pagesByPath.get(path)!.push(page);
      }
      const pagePathCounters = new Map<string, number>();

      for (let i = 0; i < navigateEvents.length; i++) {
        const nav = navigateEvents[i];
        const nextNav = navigateEvents[i + 1];
        const windowStart = nav.ts;
        const windowEnd = nextNav?.ts ?? (Date.now() + 1e9);

        // このナビゲートウィンドウに対応するページを検索
        const navPath = getPath(nav.url);
        const pagesAtPath = pagesByPath.get(navPath) || [];
        const pIdx = pagePathCounters.get(navPath) || 0;
        const page = pagesAtPath[pIdx];
        if (!page) continue; // このURLにはページが記録されていない（中間ページ）→ スキップ
        pagePathCounters.set(navPath, pIdx + 1);

        // このウィンドウ内のクリック = このページでのユーザー操作
        const windowClicks = clickEvents.filter(e => e.ts >= windowStart && e.ts < windowEnd);
        if (windowClicks.length === 0) continue;

        const lastClick = windowClicks[windowClicks.length - 1];
        page.submitSelector = lastClick.selector;
        page.submitText = lastClick.text;
        this.log('info', `  ステップ${page.stepNumber} submitSelector: "${lastClick.text}" (${lastClick.selector})`);

        if (windowClicks.length > 1) {
          page.preClicks = windowClicks.slice(0, -1).map(e => ({ selector: e.selector, text: e.text }));
          this.log('info', `  ステップ${page.stepNumber} preClicks: ${page.preClicks.length}件`);
          for (const pc of page.preClicks) {
            this.log('info', `    └ preClick: "${pc.text}" (${pc.selector})`);
          }
        }
      }
    } else {
      // ===== フォールバック: recordedAtMs方式（ナビゲートイベントがない旧記録用） =====
      this.log('warn', 'ナビゲートイベントなし → recordedAtMs方式にフォールバック');
      for (let i = 0; i < sortedPages.length; i++) {
        const page = sortedPages[i];
        const prevPage = i > 0 ? sortedPages[i - 1] : null;
        const prevMs = prevPage?.recordedAtMs || 0;
        const thisMs = page.recordedAtMs || 0;
        const clicksToReachThis = clickEvents.filter(e => e.ts > prevMs && e.ts <= thisMs);
        if (clicksToReachThis.length === 0) continue;
        if (prevPage) {
          const last = clicksToReachThis[clicksToReachThis.length - 1];
          prevPage.submitSelector = last.selector;
          prevPage.submitText = last.text;
          if (clicksToReachThis.length > 1) {
            if (!prevPage.preClicks) prevPage.preClicks = [];
            prevPage.preClicks.push(...clicksToReachThis.slice(0, -1).map(e => ({ selector: e.selector, text: e.text })));
          }
        } else {
          page.preClicks = clicksToReachThis.map(e => ({ selector: e.selector, text: e.text }));
        }
      }
    }

    // 整合後をsession.pagesに反映
    for (const sortedPage of sortedPages) {
      const idx = this.session!.pages.findIndex(p => p.id === sortedPage.id);
      if (idx >= 0) this.session!.pages[idx] = sortedPage;
    }
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

  // 再生を中止
  abortReplay(): void {
    this._replayAborted = true;
    this.log('warn', '⏹ 再生中止リクエストを受信');
  }

  // 通常モード用ラッパー（単一セッション）
  async startReplay(session: RecordingSession, testCases: TestCase[]): Promise<void> {
    const enabledCases = testCases.filter(c => c.enabled);
    await this.startReplaySuite(enabledCases.map(tc => ({ session, testCase: tc })));
  }

  // マージモード用: 複数セッションのテストケースを実行
  async startReplaySuite(items: { session: RecordingSession; testCase: TestCase }[]): Promise<void> {
    this._replayAborted = false;  // 中止フラグをリセット
    const inputHandler = new InputHandler();
    const results: ReplayResult[] = [];

    this.log('info', `━━━ Playwright Auto Test v${VERSION} ━━━`);
    this.log('info', `${items.length}件のテストケースを実行します`);

    for (const { session, testCase } of items) {
      // 中止チェック
      if (this._replayAborted) {
        this.log('warn', '⏹ 再生が中止されました');
        break;
      }
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

        // ---- セットアップpreClicks ----
        // テストケースに含まれていないセッションページのpreClicksを
        // 最初のステップのURLに対して先に実行する（モーダル閉じなど状態設定）
        const executePreClick = async (preClick: { selector: string; text: string }) => {
          try {
            this.log('info', `[${testCase.caseId}] 🖱️ preClick: ${preClick.selector} "${preClick.text}"`);
            const clicked = await page.evaluate((sel: string) => {
              const el = document.querySelector(sel);
              if (el) { (el as HTMLElement).click(); return true; }
              return false;
            }, preClick.selector).catch(() => false);
            if (!clicked) {
              await page.locator(preClick.selector).first().click({ force: true, timeout: 3000 }).catch(() => {});
            }
            await page.waitForTimeout(1000);
            
            // 「戻る」ボタン等の後にモーダル確認ダイアログが出た場合、「OK」ボタンを自動クリック
            if (preClick.text.includes('戻る')) {
              this.log('info', `[${testCase.caseId}] 🔍 戻るボタン後、OKボタンを探索中...`);
              
              // Zenrosai用OKボタンセレクタ
              const okSelectors = [
                '.s-popup_btn a.c-btn.c-next.c-bg-green',
                '.s-popup_btn_ok a.c-btn',
                'a.c-btn.c-next.c-bg-green:not(.c-back)',
              ];
              
              let okClicked = false;
              for (const sel of okSelectors) {
                try {
                  // waitForSelectorで確実にモーダルが表示されるのを待つ
                  const okBtn = await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
                  if (okBtn) {
                    this.log('info', `[${testCase.caseId}] ✅ OKボタン発見: ${sel}`);
                    await okBtn.click();
                    okClicked = true;
                    break;
                  }
                } catch {
                  // このセレクタでは見つからなかった
                }
              }
              
              if (okClicked) {
                this.log('info', `[${testCase.caseId}] 🖱️ モーダルOK自動クリック成功`);
                await page.waitForTimeout(1000);
              } else {
                this.log('warn', `[${testCase.caseId}] ⚠️ モーダルOKボタンが見つからない`);
              }
            }
            
            await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
          } catch (e: any) {
            this.log('warn', `[${testCase.caseId}] ⚠️ preClickエラー: ${preClick.selector} - ${e.message}`);
          }
        };

        if (sortedInputs.length > 0) {
          const firstSessionPage = session.pages.find(p => p.stepNumber === sortedInputs[0].stepNumber);
          const firstUrl = firstSessionPage?.url;
          const getPN = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };
          if (firstUrl) {
            const testStepNums = new Set(testCase.pageInputs.map(p => p.stepNumber));
            // テストケースに未含有 & 同URL(pathname比較) & preClicks有り のセッションページをstep順に実行
            const setupPages = session.pages
              .filter(p => getPN(p.url) === getPN(firstUrl) && !testStepNums.has(p.stepNumber) && (p.preClicks?.length ?? 0) > 0)
              .sort((a, b) => a.stepNumber - b.stepNumber);
            if (setupPages.length > 0) {
              this.log('info', `[${testCase.caseId}] 🔧 セットアップpreClicks: ${setupPages.flatMap(p => p.preClicks ?? []).length}件（${setupPages.length}ステップ分）`);
              for (const sp of setupPages) {
                for (const pc of (sp.preClicks ?? [])) {
                  await executePreClick(pc);
                }
              }
            }
          }
        }

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

          // ===== レコーディング通りの順序で実行 =====
          // 録画時: プリクリック(opener) → フィールド入力 → プリクリック(submitter) → submit
          // 最後のpreClickの前にフィールドを入力することで、モーダル内フィールドにも対応
          const allPreClicks = sessionPage?.preClicks ?? [];
          // 2件以上なら最後のpreClickをフィールド入力「後」に実行（モーダル送信ボタン等）
          // 1件以下なら全てフィールド入力「前」に実行（opener系）
          const preClicksBeforeFill = allPreClicks.length > 1
            ? allPreClicks.slice(0, -1)
            : allPreClicks;
          const submitPreClick = allPreClicks.length > 1
            ? allPreClicks[allPreClicks.length - 1]
            : null;

          // フィールド入力「前」のpreClicks（モーダルを開くなど）
          if (preClicksBeforeFill.length > 0) {
            this.log('info', `[${testCase.caseId}] 🖱️ preClicks実行(入力前): ${preClicksBeforeFill.length}件`);
            for (const preClick of preClicksBeforeFill) {
              await executePreClick(preClick);
            }
          }

          const fieldsToFill = pageInput.fieldValues.filter(f => f.value !== '');

          // 入力前キャプチャ
          await this.takeScreenshot(page, nextSsPath(), `${testCase.caseId} step${pageInput.stepNumber} before`, screenshots);
          const remainingFields = fieldsToFill;
          this.log('info', `[${testCase.caseId}] ステップ${pageInput.stepNumber}: ${remainingFields.length}個のフィールドを入力 (URL: ${page.url()})`);
          let navigationDetected = false;
          for (const field of remainingFields) {
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

          // フィールド入力「後」のpreClick（モーダル送信ボタンなど）
          if (submitPreClick) {
            this.log('info', `[${testCase.caseId}] 🖱️ submitPreClick実行(入力後): "${submitPreClick.text}" (${submitPreClick.selector})`);
            await executePreClick(submitPreClick);
          }

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
