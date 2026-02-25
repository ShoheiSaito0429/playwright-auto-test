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
        case 'recording:stop': {
          // GUIから完成されたページ情報と一緒にstopを呼ぶ
          // ページ情報はHTTP APIで別途保存される
          await browserManager.stopRecording([]);
          break;
        }
        case 'replay:start': {
          settings = loadSettings();
          const { sessionId, caseIds } = msg.payload;
          // セッションとケースを読み込み
          const recDir = path.resolve('data/recordings');
          const recFiles = fs.readdirSync(recDir).filter(f => f.endsWith('.json'));
          let session: RecordingSession | null = null;
          for (const f of recFiles) {
            const data = JSON.parse(fs.readFileSync(path.join(recDir, f), 'utf-8'));
            if (data.id === sessionId || data.name === sessionId) {
              session = data;
              break;
            }
          }
          if (!session) {
            send({ type: 'replay:error', payload: { message: 'セッションが見つかりません' } });
            break;
          }

          // テストケースを読み込み
          const caseDir = path.resolve('data/testcases');
          let allCases: TestCase[] = [];
          const caseFiles = fs.readdirSync(caseDir).filter(f => f.endsWith('.json'));
          for (const f of caseFiles) {
            const data = JSON.parse(fs.readFileSync(path.join(caseDir, f), 'utf-8'));
            if (data.cases) allCases = [...allCases, ...data.cases];
          }

          const targetCases = caseIds.length > 0
            ? allCases.filter(c => caseIds.includes(c.caseId))
            : allCases;

          const replayManager = new BrowserManager(settings, send);
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
  console.log(`║   URL: http://localhost:${PORT}                  ║`);
  console.log('║                                                ║');
  console.log('║   ブラウザで上記URLを開いてください              ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
});
