import type { Page } from 'playwright';
import type { RecordedField } from '../types.js';
import { v4 as uuid } from 'uuid';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ブラウザ実行スクリプトを文字列として読み込む（esbuildの__name注入を回避）
const collectFieldsScript = readFileSync(
  join(__dirname, '../browser-scripts/collect-fields.js'),
  'utf8'
);
const installWatcherScript = readFileSync(
  join(__dirname, '../browser-scripts/install-watcher.js'),
  'utf8'
);

/**
 * ページ内の全入力フィールド情報を自動収集
 */
export async function collectPageFields(page: Page): Promise<RecordedField[]> {
  const rawFields = await page.evaluate(collectFieldsScript) as any[];
  return rawFields.map(f => ({ ...f, id: uuid() }));
}

/**
 * MutationObserver をページに注入して、フィールドの状態変化を監視する
 */
export async function installFieldWatcher(page: Page, onFieldChanged: () => void): Promise<void> {
  // すでに登録済みの場合は無視（ページナビゲーション後の再注入対応）
  try {
    await page.exposeFunction('__fieldWatcherCallback', () => {
      onFieldChanged();
    });
  } catch (e: any) {
    if (!e?.message?.includes('already registered')) throw e;
  }

  await page.evaluate(installWatcherScript);
}
