// 全労済サイトでの検証スクリプト
import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3200';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function test() {
  console.log('=== 全労済サイト検証 ===');
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
      collectedPages.push(msg.payload);
      console.log(`[PAGE] ステップ${msg.payload.stepNumber} (${msg.payload.fields?.length}フィールド) → 合計${collectedPages.length}ページ`);
    }
    if (msg.type === 'recording:complete') {
      console.log('[COMPLETE] 録画完了');
    }
  });
  
  await new Promise(r => ws.on('open', r));
  console.log('WebSocket接続OK\n');
  
  // 全労済サイト
  const testUrl = 'https://www.zenrosai.coop/ss/kakekin/mycar/202111/shinki01.php';
  
  console.log(`録画開始: ${testUrl}`);
  ws.send(JSON.stringify({
    type: 'recording:start',
    payload: { url: testUrl }
  }));
  
  // 20秒待機（ページ読み込み＋フィールド収集）
  console.log('フィールド収集待機（20秒）...\n');
  await sleep(20000);
  
  console.log(`\n収集されたページ数: ${collectedPages.length}`);
  for (const p of collectedPages) {
    console.log(`  ステップ${p.stepNumber}: ${p.fields?.length || 0}フィールド, preClicks=${p.preClicks?.length || 0}`);
  }
  
  // 録画停止
  console.log('\n録画停止・保存...');
  ws.send(JSON.stringify({
    type: 'recording:stop',
    payload: { pages: collectedPages }
  }));
  
  await sleep(3000);
  
  // サマリーログ抽出
  console.log('\n=== サマリーログ ===');
  const summaryLogs = logs.filter(l => 
    l.includes('サマリー') || l.includes('合計') || 
    l.includes('ステップ') || l.includes('preClick') ||
    l.includes('保存しました')
  );
  summaryLogs.forEach(l => console.log(l));
  
  ws.close();
  console.log('\n=== 検証完了 ===');
  process.exit(0);
}

test().catch(e => { console.error(e); process.exit(1); });
