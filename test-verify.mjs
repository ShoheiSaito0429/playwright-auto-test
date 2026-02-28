// 動作検証スクリプト
// stepNumberベースの録画が正しく動作するか検証

import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3200';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function test() {
  console.log('=== 動作検証開始 ===\n');
  
  const ws = new WebSocket(WS_URL);
  const logs = [];
  const pages = [];
  let sessionComplete = false;
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.type === 'log') {
      const log = `[${msg.payload.level}] ${msg.payload.message}`;
      logs.push(log);
      console.log(log);
    }
    
    if (msg.type === 'recording:page-collected') {
      pages.push(msg.payload);
      console.log(`\n📄 ページ収集: ステップ${msg.payload.stepNumber}, ${msg.payload.fields.length}フィールド`);
    }
    
    if (msg.type === 'recording:complete') {
      sessionComplete = true;
      console.log('\n✅ 録画完了');
    }
  });
  
  await new Promise(resolve => ws.on('open', resolve));
  console.log('WebSocket接続OK\n');
  
  // 録画開始（全労済のサンプルURL）
  const testUrl = 'https://www.zenrosai.coop/ss/kakekin/mycar/202111/shinki01.php';
  console.log(`録画開始: ${testUrl}\n`);
  
  ws.send(JSON.stringify({
    type: 'recording:start',
    payload: { url: testUrl }
  }));
  
  // 30秒待機（手動操作をシミュレート）
  console.log('⏳ 30秒待機（フィールド自動収集を確認）...\n');
  await sleep(30000);
  
  // 録画停止
  console.log('\n録画停止...');
  ws.send(JSON.stringify({
    type: 'recording:stop',
    payload: { pages }
  }));
  
  await sleep(3000);
  
  // 結果サマリー
  console.log('\n=== 検証結果 ===');
  console.log(`収集ページ数: ${pages.length}`);
  
  for (const page of pages) {
    console.log(`  ステップ${page.stepNumber}: ${page.fields.length}フィールド, preClicks=${page.preClicks?.length || 0}`);
  }
  
  // ログから重要な情報を抽出
  const stepLogs = logs.filter(l => l.includes('ステップ'));
  const preClickLogs = logs.filter(l => l.includes('preClick'));
  const summaryLogs = logs.filter(l => l.includes('記録サマリー') || l.includes('合計ページ'));
  
  console.log('\n=== 重要ログ ===');
  stepLogs.forEach(l => console.log(l));
  preClickLogs.forEach(l => console.log(l));
  summaryLogs.forEach(l => console.log(l));
  
  ws.close();
  console.log('\n=== 検証完了 ===');
}

test().catch(console.error);
