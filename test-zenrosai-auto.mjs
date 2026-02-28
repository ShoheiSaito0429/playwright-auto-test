// 全労済サイト自動操作検証
import { chromium } from 'playwright';
import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3200';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function test() {
  console.log('=== 全労済サイト 自動操作検証 ===');
  console.log('時刻:', new Date().toLocaleString('ja-JP'));
  
  const ws = new WebSocket(WS_URL);
  const collectedPages = [];
  const logs = [];
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'log') {
      console.log(`[LOG] ${msg.payload.message}`);
      logs.push(msg.payload.message);
    }
    if (msg.type === 'recording:page-collected') {
      // GUIと同じロジック: stepNumberで判定
      const existing = collectedPages.findIndex(p => p.stepNumber === msg.payload.stepNumber);
      if (existing >= 0) {
        collectedPages[existing] = msg.payload;
        console.log(`[PAGE] ステップ${msg.payload.stepNumber} 更新 (${msg.payload.fields?.length}フィールド, preClicks=${msg.payload.preClicks?.length || 0})`);
      } else {
        collectedPages.push(msg.payload);
        console.log(`[PAGE] ステップ${msg.payload.stepNumber} 追加 (${msg.payload.fields?.length}フィールド, preClicks=${msg.payload.preClicks?.length || 0})`);
      }
    }
    if (msg.type === 'browser:navigated') {
      console.log(`[NAV] ${msg.payload.url.substring(0, 60)}...`);
    }
  });
  
  await new Promise(r => ws.on('open', r));
  console.log('WebSocket接続OK\n');
  
  // 録画開始
  const testUrl = 'https://www.zenrosai.coop/ss/kakekin/mycar/202111/shinki01.php';
  console.log(`録画開始: ${testUrl}\n`);
  ws.send(JSON.stringify({
    type: 'recording:start',
    payload: { url: testUrl }
  }));
  
  // 録画用ブラウザが起動するまで待機
  await sleep(8000);
  
  // 別のPlaywrightインスタンスでCDP接続して操作
  console.log('\n=== 自動操作開始 ===');
  
  // 録画中のブラウザに接続（CDPエンドポイント経由）
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error('ブラウザコンテキストが見つかりません');
    process.exit(1);
  }
  
  const pages = contexts[0].pages();
  const page = pages[0];
  console.log(`接続成功: ${await page.title()}`);
  
  // Step 1: 「加入していない」をクリック
  console.log('\n[操作1] 「加入していない」クリック');
  await page.click('a.s-btn.s-not_member').catch(e => console.log('  → ' + e.message));
  await sleep(2000);
  
  // Step 2: 「お見積もりの開始」をクリック
  console.log('[操作2] 「お見積もりの開始」クリック');
  await page.click('a.c-btn:has-text("お見積もりの開始")').catch(e => console.log('  → ' + e.message));
  await sleep(2000);
  
  // Step 3: 「次へ」をクリック
  console.log('[操作3] 「次へ」クリック');
  await page.click('a.c-btn:has-text("次へ")').catch(e => console.log('  → ' + e.message));
  await sleep(2000);
  
  // Step 4: 「同意して次へ」をクリック
  console.log('[操作4] 「同意して次へ」クリック');
  await page.click('a.c-btn:has-text("同意して次へ")').catch(e => console.log('  → ' + e.message));
  await sleep(3000);
  
  console.log('\n=== 自動操作完了 ===');
  console.log(`収集ページ数: ${collectedPages.length}`);
  
  // 録画停止
  console.log('\n録画停止・保存...');
  ws.send(JSON.stringify({
    type: 'recording:stop',
    payload: { pages: collectedPages }
  }));
  
  await sleep(3000);
  
  // サマリー
  console.log('\n=== 最終結果 ===');
  for (const p of collectedPages) {
    const preClicks = p.preClicks?.map(pc => pc.text).join(', ') || 'なし';
    console.log(`ステップ${p.stepNumber}: ${p.fields?.length}フィールド, preClicks=[${preClicks}]`);
  }
  
  await browser.close();
  ws.close();
  console.log('\n=== 検証完了 ===');
  process.exit(0);
}

test().catch(e => { console.error(e); process.exit(1); });
