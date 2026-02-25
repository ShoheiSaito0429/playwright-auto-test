# Playwright Auto Test - GUI版

Webアプリケーションの自動テストツール。GUI操作で「記録→ケース作成→再生」の一連のワークフローを実行できます。

## 特徴

- **GUI操作**: ブラウザベースのダッシュボードで全操作可能
- **フィールド自動収集**: ページ読み込み完了時に入力フィールドを自動検出
- **全入力タイプ対応**: テキスト、ラジオボタン、セレクトボックス、チェックボックス、ファイルアップロード
- **テストケース編集**: GUI上でケース表を編集・Excel出力可能
- **キャプチャ取得**: 入力前・入力後の2枚を自動保存
- **リアルタイム表示**: WebSocketによる実行状況のライブ表示
- **環境非依存**: Node.jsがあればどこでも動作

## セットアップ

```bash
# 依存パッケージインストール
npm install

# Playwrightブラウザインストール
npx playwright install chromium

# サーバー起動
npm run dev
```

ブラウザで http://localhost:3200 を開く

## 使い方

### Step 1: 設定（⚙️ 設定タブ）
- 対象サイトのURL、ログインフォームのセレクタを設定

### Step 2: 記録（📹 記録タブ）
1. 「記録開始」をクリック → Playwrightブラウザが起動
2. 手動でログイン・画面操作
3. **ページ読み込み時にフィールドが自動収集**される
4. 画面上で収集されたフィールドと値をリアルタイム確認
5. 全画面完了後「記録停止・保存」をクリック

### Step 3: テストケース作成（📋 テストケースタブ）
1. セッションを選択
2. 記録時の値がケース1として自動入力済み
3. 「ケース追加」で新しいケースを追加
4. 各フィールドの値をGUI上で編集
5. 「保存」またはExcel出力

### Step 4: 再生（▶️ 再生タブ）
1. セッションを選択して「再生開始」
2. 各ケースが自動実行され、進捗がリアルタイム表示
3. 入力前・入力後のスクリーンショットがグリッド表示

## ディレクトリ構成

```
playwright-auto-test/
├── src/
│   ├── server/
│   │   ├── index.ts            # Express + WebSocket サーバー
│   │   ├── browser-manager.ts  # Playwright操作の管理
│   │   ├── field-collector.ts  # フィールド自動収集
│   │   └── input-handler.ts    # 入力タイプ別ハンドラ
│   └── types.ts                # 型定義
├── public/
│   └── index.html              # GUIフロントエンド
├── config/
│   └── settings.json           # サイト設定
├── data/                       # 自動生成
│   ├── recordings/             # 記録データ (JSON)
│   ├── testcases/              # テストケース (JSON/Excel)
│   └── screenshots/            # スクリーンショット
├── package.json
└── README.md
```

## 技術スタック

- **バックエンド**: Express + WebSocket + Playwright
- **フロントエンド**: Vanilla HTML/CSS/JS（依存なし）
- **通信**: REST API + WebSocket（リアルタイム更新）
- **ランタイム**: Node.js + tsx（TypeScript直接実行）
