// ========================================
// 共有型定義
// ========================================

export type InputType = 'text' | 'radio' | 'select' | 'checkbox' | 'file' | 'textarea' | 'password' | 'date' | 'number' | 'email' | 'hidden' | 'tel' | 'url';

/** フィールドの表示・活性状態 */
export type FieldState = 'active' | 'disabled' | 'readonly' | 'hidden' | 'collapsed';

export interface RecordedField {
  id: string;
  selector: string;
  type: InputType;
  label: string;
  name: string;
  elementId: string;
  value: string;
  checked?: boolean;
  selectedText?: string;
  filePath?: string;
  radioValue?: string;
  options?: Array<{ value: string; text: string }>;
  state: FieldState;
  isDisabled: boolean;
  isReadonly: boolean;
  isVisible: boolean;
  isHiddenByCSS: boolean;
  dependsOn?: string;
  ariaDisabled?: boolean;
}

export interface PreClick {
  selector: string;
  text: string;
  href?: string;  // 要素のhref属性（セレクタ曖昧時の補完用）
}

export interface ClickEvent {
  type?: 'click' | 'navigate';  // 省略時は'click'
  ts: number;       // Date.now() ミリ秒
  url: string;      // クリック時のURL
  selector: string;
  text: string;
  tag: string;
  href?: string;    // 要素のhref属性
}

export interface RecordedPage {
  id: string;
  url: string;
  title: string;
  stepNumber: number;
  fields: RecordedField[];
  /** ナビゲーション前の事前クリック（モーダル閉じなど） */
  preClicks?: PreClick[];
  submitSelector?: string;
  submitText?: string;
  recordedAt: string;
  recordedAtMs: number;  // ページ収集時のミリ秒タイムスタンプ
}

export interface RecordingSession {
  id: string;
  name: string;
  startUrl: string;
  /** 全ページ（ログイン画面含む） */
  pages: RecordedPage[];
  /** ユーザーの実操作ログ（v2 インタラクション記録） */
  interactions?: Interaction[];
  startedAt: string;
  completedAt: string;
}

export interface TestCase {
  caseId: string;
  caseName: string;
  /** 全ページの入力値（ログイン画面もステップの1つとして含む） */
  pageInputs: PageInput[];
  enabled: boolean;
}

export interface PageInput {
  stepNumber: number;
  pageId: string;
  fieldValues: FieldValue[];
  submitSelector?: string;
}

export interface FieldValue {
  fieldId: string;
  selector: string;
  type: InputType;
  label: string;
  value: string;
  filePath?: string;
}

/** 設定（簡素化: ブラウザ設定のみ） */
export interface Settings {
  browser: {
    headless: boolean;
    slowMo: number;
    viewport: { width: number; height: number };
  };
  screenshot: {
    fullPage: boolean;
    format: 'png' | 'jpeg';
  };
  timeout: {
    navigation: number;
    action: number;
  };
}

// WebSocket メッセージ型
export type WSMessage =
  | { type: 'recording:start'; payload: { url: string } }
  | { type: 'recording:stop' }
  | { type: 'recording:capture' }
  | { type: 'recording:detect-submit'; payload: { pageId: string } }
  | { type: 'recording:page-collected'; payload: RecordedPage }
  | { type: 'recording:submit-detected'; payload: { pageId: string; submitSelector: string; submitText: string } }
  | { type: 'recording:status'; payload: { status: string; url?: string; step?: number } }
  | { type: 'recording:complete'; payload: RecordingSession }
  | { type: 'recording:error'; payload: { message: string } }
  | { type: 'replay:start'; payload: { sessionId: string; caseIds: string[] } }
  | { type: 'replay:progress'; payload: { caseId: string; step: number; total: number; status: string; screenshot?: string } }
  | { type: 'replay:complete'; payload: { results: ReplayResult[] } }
  | { type: 'replay:error'; payload: { caseId?: string; message: string } }
  | { type: 'browser:navigated'; payload: { url: string; title: string } }
  | { type: 'fields:collected'; payload: { pageId: string; fields: RecordedField[] } }
  | { type: 'log'; payload: { level: 'info' | 'warn' | 'error'; message: string } }
  | { type: 'collecting:start'; payload: Record<string, never> }
  | { type: 'collecting:end'; payload: Record<string, never> }
  | { type: 'replay:abort' };

export interface ReplayResult {
  caseId: string;
  caseName: string;
  status: 'success' | 'error';
  error?: string;
  screenshots: string[];
  duration: number;
}

// ========================================
// インタラクション記録（v2）
// ========================================

export type InteractionAction = 'change' | 'click' | 'input';

export interface Interaction {
  id: string;
  pageUrl: string;
  action: InteractionAction;
  selector: string;
  elementType: string;   // 'radio' | 'select' | 'text' | 'a' | 'button' etc.
  value: string;         // 入力値 / radio value / select value / click href
  label: string;
  timestamp: number;
  msSincePrev: number;   // 前のインタラクションからの経過ms（wait 生成に使用）
}
