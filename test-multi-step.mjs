// 複数ステップの検証スクリプト
// 同一URLで複数ステップが正しく記録されるかテスト
import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3200';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function test() {
  console.log('=== 複数ステップ検証 ===');
  console.log('時刻:', new Date().toLocaleString('ja-JP'));
  
  const ws = new WebSocket(WS_URL);
  const collectedPages = [];
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'log') {
      console.log(`[LOG] ${msg.payload.message}`);
    }
    if (msg.type === 'recording:page-collected') {
      collectedPages.push(msg.payload);
      console.log(`[PAGE] ステップ${msg.payload.stepNumber} (${msg.payload.fields?.length}フィールド) → 合計${collectedPages.length}ページ`);
    }
  });
  
  await new Promise(r => ws.on('open', r));
  console.log('WebSocket接続OK\n');
  
  // 録画開始
  ws.send(JSON.stringify({
    type: 'recording:start',
    payload: { url: 'https://httpbin.org/forms/post' }
  }));
  
  await sleep(10000);
  console.log(`\n現在の収集ページ数: ${collectedPages.length}`);
  
  // 同一URLでステップを追加するシミュレーション
  // （実際のGUIでは、画面変化→フィールド再収集で発生）
  // テスト用に手動でpage-collectedイベントを確認
  
  // 別のURLに遷移をシミュレート
  console.log('\n=== 別URLへ遷移シミュレーション ===');
  const fakeStep2 = {
    id: 'test-step-2',
    url: 'https://httpbin.org/forms/post', // 同じURL
    title: 'Step 2 (same URL)',
    stepNumber: 2,
    fields: [{ id: 'f1', selector: '#test', type: 'text', label: 'Test', name: 'test', value: '' }],
    preClicks: [{ selector: 'button.next', text: '次へ' }],
    submitSelector: 'button[type=submit]',
    submitText: '送信'
  };
  
  const fakeStep3 = {
    id: 'test-step-3',
    url: 'https://httpbin.org/forms/post', // 同じURL
    title: 'Step 3 (same URL)',
    stepNumber: 3,
    fields: [{ id: 'f2', selector: '#confirm', type: 'checkbox', label: 'Confirm', name: 'confirm', value: '' }],
    preClicks: [{ selector: 'a.back', text: '戻る' }, { selector: 'button.ok', text: 'OK' }],
    submitSelector: 'button.complete',
    submitText: '完了'
  };
  
  collectedPages.push(fakeStep2);
  collectedPages.push(fakeStep3);
  console.log(`シミュレーション後のページ数: ${collectedPages.length}`);
  
  // 録画停止
  console.log('\n=== 録画停止・保存 ===');
  ws.send(JSON.stringify({
    type: 'recording:stop',
    payload: { pages: collectedPages }
  }));
  
  await sleep(3000);
  
  ws.close();
  console.log('\n=== 検証完了 ===');
  process.exit(0);
}

test().catch(e => { console.error(e); process.exit(1); });
