import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import { BrowserManager } from './browser-manager.js';
import type { Settings, WSMessage, RecordedPage, TestCase, RecordingSession } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3200;

// バージョン情報
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));
const VERSION = packageJson.version;

// ===== 設定読み込み =====
const CONFIG_PATH = path.resolve('config/settings.json');
const defaultSettings: Settings = {
  browser: { headless: false, slowMo: 100, viewport: { width: 1280, height: 900 } },
  screenshot: { fullPage: true, format: 'png' },
  timeout: { navigation: 30000, action: 10000 },
};

function loadSettings(): Settings {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultSettings, null, 2), 'utf-8');
  }
  return { ...defaultSettings, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
}

// ===== データディレクトリ =====
['data/recordings', 'data/testcases', 'data/screenshots'].forEach(d =>
  fs.mkdirSync(path.resolve(d), { recursive: true })
);

// ===== Express =====
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.resolve(__dirname, '../../public')));

// スクリーンショット画像の配信
app.use('/screenshots', express.static(path.resolve('data/screenshots')));

// バージョンAPI
app.get('/api/version', (_req, res) => {
  res.json({ version: VERSION, buildDate: VERSION.split('-')[1] || 'unknown' });
});

// ログファイル一覧・ダウンロード
app.get('/api/logs', (_req, res) => {
  const dir = path.resolve('data/logs');
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort().reverse();
  res.json(files);
});
app.get('/api/logs/:filename', (req, res) => {
  const filePath = path.resolve('data/logs', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  res.send(fs.readFileSync(filePath, 'utf-8'));
});

app.delete('/api/logs/:filename', (req, res) => {
  const filePath = path.resolve('data/logs', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// === API: 設定 ===
app.get('/api/settings', (_req, res) => {
  res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
  const settings = req.body;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  res.json({ ok: true });
});

// === API: 記録一覧 ===
app.get('/api/recordings', (_req, res) => {
  const dir = path.resolve('data/recordings');
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
  const recordings = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    return { id: data.id, name: data.name, startUrl: data.startUrl, pages: data.pages?.length || 0, startedAt: data.startedAt };
  });
  res.json(recordings);
});

app.get('/api/recordings/:name', (req, res) => {
  const filePath = path.resolve('data/recordings', `${req.params.name}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
});

// === API: 記録セッションを保存（GUI側からページ情報を含めて保存） ===
app.post('/api/recordings/:name', (req, res) => {
  const dir = path.resolve('data/recordings');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${req.params.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), 'utf-8');
  res.json({ ok: true });
});

// === API: テストケース ===
app.get('/api/testcases', (_req, res) => {
  const dir = path.resolve('data/testcases');
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
  const cases = files.map(f => ({
    name: f.replace('.json', ''),
    ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')),
  }));
  res.json(cases);
});

app.post('/api/testcases/:name', (req, res) => {
  const dir = path.resolve('data/testcases');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${req.params.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), 'utf-8');
  res.json({ ok: true });
});

// ケース単体削除
app.delete('/api/testcases/:name/cases/:caseId', (req, res) => {
  const dir = path.resolve('data/testcases');
  const filePath = path.join(dir, `${req.params.name}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  data.cases = (data.cases || []).filter((c: any) => c.caseId !== req.params.caseId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  res.json({ ok: true, remaining: data.cases.length });
});

// ケース単体追加（空ケース）
app.post('/api/testcases/:name/cases', (req, res) => {
  const dir = path.resolve('data/testcases');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${req.params.name}.json`);
  const data = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    : { sessionName: req.params.name, cases: [] };
  const newCase = req.body; // { caseId, caseName, enabled, pageInputs }
  data.cases = [...(data.cases || []), newCase];
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  res.json({ ok: true, case: newCase });
});

// === API: テストケースをExcelエクスポート（転置レイアウト） ===
app.post('/api/testcases/:name/export', (req, res) => {
  const { session, cases }: { session: RecordingSession; cases: TestCase[] } = req.body;
  const wb = XLSX.utils.book_new();

  // ===== シート1: テストケース（転置: フィールドが縦、ケースが横） =====
  const rows: string[][] = [];

  // ヘッダー行: 左端は項目名、右にケースIDが並ぶ
  rows.push(['項目', ...cases.map(c => c.caseId)]);
  // ケース名行
  rows.push(['ケース名', ...cases.map(c => c.caseName)]);
  // 区切り行
  rows.push([]);

  // フィールド定義メタ情報（シート2用にも使う）
  const fieldMeta: Array<{ stepNumber: number; type: string; selector: string; label: string; state: string }> = [];

  // フィールド行
  for (const page of session.pages) {
    // 画面ヘッダー行
    rows.push([`=== 画面${page.stepNumber}: ${page.title || ''} ===`]);

    for (const field of page.fields) {
      const label = field.label || field.name || field.elementId || field.selector;
      const stateLabel = (field as any).state && (field as any).state !== 'active' ? ` [${(field as any).state}]` : '';
      const rowLabel = `[${field.type}] ${label}${stateLabel}`;

      // 各ケースの値を取得
      const caseValues = cases.map(c => {
        const pageInput = c.pageInputs.find(pi => pi.stepNumber === page.stepNumber);
        if (!pageInput) return '';
        const fv = pageInput.fieldValues.find(f => f.fieldId === field.id || f.selector === field.selector);
        return fv?.value || '';
      });

      rows.push([rowLabel, ...caseValues]);

      fieldMeta.push({
        stepNumber: page.stepNumber,
        type: field.type,
        selector: field.selector,
        label: label,
        state: (field as any).state || 'active',
      });
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  // 列幅: 左端は広め、ケース列は均等
  ws['!cols'] = [{ wch: 35 }, ...cases.map(() => ({ wch: 20 }))];
  XLSX.utils.book_append_sheet(wb, ws, 'テストケース');

  // ===== シート2: フィールド定義 =====
  const defData = [
    ['ステップ', 'タイプ', '状態', 'セレクタ', 'ラベル'],
    ...fieldMeta.map(m => [String(m.stepNumber), m.type, m.state, m.selector, m.label]),
  ];
  const wsDef = XLSX.utils.aoa_to_sheet(defData);
  wsDef['!cols'] = [{ wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 40 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, wsDef, 'フィールド定義');

  // ===== シート3: ページ遷移 =====
  const navData = [
    ['ステップ', 'URL', 'タイトル', '送信ボタン', 'ボタンテキスト'],
    ...session.pages.map(p => [String(p.stepNumber), p.url, p.title, p.submitSelector || '', p.submitText || '']),
  ];
  const wsNav = XLSX.utils.aoa_to_sheet(navData);
  wsNav['!cols'] = [{ wch: 8 }, { wch: 40 }, { wch: 25 }, { wch: 30 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, wsNav, 'ページ遷移');

  const dir = path.resolve('data/testcases');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${req.params.name}.xlsx`);
  XLSX.writeFile(wb, filePath);
  res.json({ ok: true, path: filePath });
});

// === API: インポート（Excel → テストケース） ===
app.post('/api/import', express.raw({ type: 'application/octet-stream', limit: '10mb' }), (req, res) => {
  try {
    const wb = XLSX.read(req.body, { type: 'buffer' });

    const ws1 = wb.Sheets['テストケース'];
    const ws2 = wb.Sheets['フィールド定義'];
    const ws3 = wb.Sheets['ページ遷移'];

    if (!ws1 || !ws2) {
      return res.status(400).json({ error: 'シート「テストケース」「フィールド定義」が見つかりません' });
    }

    const rows = XLSX.utils.sheet_to_json(ws1, { header: 1, defval: '' }) as string[][];
    const fieldDefs = (XLSX.utils.sheet_to_json(ws2, { header: 1, defval: '' }) as string[][]).slice(1);
    const navRows = ws3 ? (XLSX.utils.sheet_to_json(ws3, { header: 1, defval: '' }) as string[][]).slice(1) : [];

    // ケースID / ケース名を取得
    const caseIds: string[] = (rows[0] || []).slice(1).map(String).filter(Boolean);
    const caseNames: string[] = (rows[1] || []).slice(1).map(String);

    if (caseIds.length === 0) return res.status(400).json({ error: 'ケースIDが見つかりません' });

    const cases = caseIds.map((id, i) => ({
      caseId: id,
      caseName: caseNames[i] || id,
      pageInputs: [] as any[],
      enabled: true,
    }));

    let fieldIndex = 0;
    let currentStep = 1;

    for (let ri = 3; ri < rows.length; ri++) {
      const row = rows[ri];
      if (!row || row.every(c => c === '')) continue;

      const firstCell = String(row[0] || '');
      const pageMatch = firstCell.match(/画面(\d+)/);
      if (pageMatch) { currentStep = parseInt(pageMatch[1]); continue; }

      const meta = fieldDefs[fieldIndex++];
      if (!meta) continue;

      const stepNumber = parseInt(String(meta[0])) || currentStep;
      const fieldType = String(meta[1] || 'text');
      const fieldSelector = String(meta[3] || '');
      const fieldLabel = String(meta[4] || '');

      cases.forEach((tc, ci) => {
        const value = String(row[ci + 1] ?? '');
        if (value === '') return;

        let pi = tc.pageInputs.find((p: any) => p.stepNumber === stepNumber);
        if (!pi) {
          pi = { stepNumber, pageId: '', fieldValues: [], submitSelector: '' };
          tc.pageInputs.push(pi);
        }
        pi.fieldValues.push({
          fieldId: `${stepNumber}_${fieldSelector}`,
          selector: fieldSelector,
          type: fieldType,
          label: fieldLabel,
          value,
        });
      });
    }

    // submitSelector を設定
    navRows.forEach(navRow => {
      const step = parseInt(String(navRow[0]));
      const submitSel = String(navRow[3] || '');
      cases.forEach(tc => {
        const pi = tc.pageInputs.find((p: any) => p.stepNumber === step);
        if (pi && submitSel) pi.submitSelector = submitSel;
      });
    });

    res.json({ ok: true, cases });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// === API: 実行結果 ===
app.get('/api/results', (_req, res) => {
  const dir = path.resolve('data/screenshots');
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => f.startsWith('result_') && f.endsWith('.json')).sort().reverse();
  const results = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
  res.json(results);
});

// ===== HTTP + WebSocket サーバー =====
const server = createServer(app);
const wss = new WebSocketServer({ server });

let settings = loadSettings();
let browserManager = new BrowserManager(settings, () => {});

wss.on('connection', (ws: WebSocket) => {
  console.log('🔌 WebSocket接続');

  const send = (msg: WSMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  browserManager.updateSend(send);

  ws.on('message', async (raw: Buffer) => {
    try {
      const msg: WSMessage = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'recording:start': {
          settings = loadSettings();
          browserManager = new BrowserManager(settings, send);
          const url = msg.payload.url || `${settings.baseUrl}${settings.loginPath}`;
          await browserManager.startRecording(url);
          break;
        }
        case 'recording:capture': {
          await browserManager.manualCollect();
          break;
        }
        case 'recording:detect-submit': {
          const { pageId } = msg.payload;
          const result = await browserManager.detectSubmitButton();
          send({ type: 'recording:submit-detected', payload: { pageId, ...result } });
          break;
        }
        case 'recording:stop': {
          // GUIから完成されたページ情報と一緒にstopを呼ぶ
          const pages = (msg.payload as any)?.pages || [];
          await browserManager.stopRecording(pages);
          break;
        }
        case 'replay:abort': {
          browserManager.abortReplay();
          break;
        }
        case 'replay:start': {
          settings = loadSettings();
          const { sessionId, caseIds, items } = msg.payload;

          const recDir = path.resolve('data/recordings');
          const caseDir = path.resolve('data/testcases');

          // セッション名からRecordingSessionを読み込むヘルパー
          const loadSession = (nameOrId: string): RecordingSession | null => {
            const recFiles = fs.readdirSync(recDir).filter(f => f.endsWith('.json'));
            for (const f of recFiles) {
              const data = JSON.parse(fs.readFileSync(path.join(recDir, f), 'utf-8'));
              if (data.id === nameOrId || data.name === nameOrId) return data;
            }
            return null;
          };

          // セッション名からTestCaseを取得するヘルパー
          const loadTestCase = (sessionName: string, caseId: string): TestCase | null => {
            const caseFiles = fs.readdirSync(caseDir).filter(f => f.endsWith('.json'));
            for (const f of caseFiles) {
              const data = JSON.parse(fs.readFileSync(path.join(caseDir, f), 'utf-8'));
              if (data.sessionName === sessionName || f === `${sessionName}.json`) {
                const found = data.cases?.find((c: TestCase) => c.caseId === caseId);
                if (found) return found;
              }
            }
            return null;
          };

          const replayManager = new BrowserManager(settings, send);

          // ===== マージモード: items配列で複数セッション実行 =====
          if (items && Array.isArray(items) && items.length > 0) {
            const suiteItems: { session: RecordingSession; testCase: TestCase }[] = [];
            for (const item of items as { sessionName: string; caseId: string }[]) {
              const s = loadSession(item.sessionName);
              const tc = loadTestCase(item.sessionName, item.caseId);
              if (s && tc) {
                suiteItems.push({ session: s, testCase: tc });
              } else {
                console.warn(`マージ: セッション/ケース未発見 → ${item.sessionName} / ${item.caseId}`);
              }
            }
            if (suiteItems.length === 0) {
              send({ type: 'replay:error', payload: { message: '実行可能なケースが見つかりません' } });
              break;
            }
            await replayManager.startReplaySuite(suiteItems);
            break;
          }

          // ===== 通常モード: 単一セッション =====
          const session = loadSession(sessionId);
          if (!session) {
            send({ type: 'replay:error', payload: { message: 'セッションが見つかりません' } });
            break;
          }

          let allCases: TestCase[] = [];
          const caseFiles2 = fs.readdirSync(caseDir).filter(f => f.endsWith('.json'));
          for (const f of caseFiles2) {
            const data = JSON.parse(fs.readFileSync(path.join(caseDir, f), 'utf-8'));
            if (data.cases && (data.sessionName === session.name || f === `${session.name}.json`)) {
              allCases = [...allCases, ...data.cases];
            }
          }

          const targetCases = caseIds.length > 0
            ? allCases.filter((c: TestCase) => caseIds.includes(c.caseId))
            : allCases;

          await replayManager.startReplay(session, targetCases);
          break;
        }
      }
    } catch (err: any) {
      console.error('WebSocketメッセージ処理エラー:', err);
      send({ type: 'recording:error', payload: { message: err.message } });
    }
  });

  ws.on('close', () => {
    console.log('🔌 WebSocket切断');
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   🚀 Playwright Auto Test - GUI サーバー起動    ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║   Version: ${VERSION.padEnd(35)}║`);
  console.log(`║   URL: http://localhost:${PORT}                  ║`);
  console.log('║                                                ║');
  console.log('║   ブラウザで上記URLを開いてください              ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
});
