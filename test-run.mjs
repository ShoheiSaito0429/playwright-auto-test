// 自動検証スクリプト - Docker内で実行
import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3200';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function test() {
  console.log('=== 自動検証開始 ===');
  console.log('時刻:', new Date().toLocaleString('ja-JP'));
  
  const ws = new WebSocket(WS_URL);
  const collectedPages = [];
  let logs = [];
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.type === 'log') {
      console.log(`[LOG] ${msg.payload.message}`);
      logs.push(msg.payload.message);
    }
    
    if (msg.type === 'recording:page-collected') {
      collectedPages.push(msg.payload);
      console.log(`[PAGE] ステップ${msg.payload.stepNumber} 追加 → 合計${collectedPages.length}ページ`);
    }
    
    if (msg.type === 'recording:complete') {
      console.log('[COMPLETE] 録画完了');
    }
  });
  
  ws.on('error', (e) => console.error('WS Error:', e.message));
  
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 10000);
  });
  
  console.log('\n[1] WebSocket接続OK');
  
  // テスト用サイト（シンプルなフォームページ）
  const testUrl = 'https://httpbin.org/forms/post';
  
  console.log(`[2] 録画開始: ${testUrl}`);
  ws.send(JSON.stringify({
    type: 'recording:start',
    payload: { url: testUrl }
  }));
  
  // フィールド収集を待つ
  console.log('[3] フィールド収集待機（15秒）...');
  await sleep(15000);
  
  console.log(`[4] 収集されたページ数: ${collectedPages.length}`);
  
  // 録画停止
  console.log('[5] 録画停止・保存');
  ws.send(JSON.stringify({
    type: 'recording:stop',
    payload: { pages: collectedPages }
  }));
  
  await sleep(3000);
  
  // 結果表示
  console.log('\n=== 検証結果 ===');
  console.log(`収集ページ数: ${collectedPages.length}`);
  for (const p of collectedPages) {
    console.log(`  ステップ${p.stepNumber}: ${p.fields?.length || 0}フィールド, preClicks=${p.preClicks?.length || 0}`);
  }
  
  console.log('\n=== サマリーログ ===');
  const summaryLogs = logs.filter(l => 
    l.includes('サマリー') || l.includes('合計') || l.includes('ステップ') || l.includes('preClick')
  );
  summaryLogs.forEach(l => console.log(l));
  
  ws.close();
  console.log('\n=== 検証完了 ===');
  process.exit(0);
}

test().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
