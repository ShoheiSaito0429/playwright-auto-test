// テスト: 記録機能でボタン検出を確認
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3201');

ws.on('open', () => {
  console.log('✅ WebSocket接続');
  
  // 全労済のURLで記録開始
  const startUrl = 'https://www.zenrosai.coop/ss/kakekin/kantanshindan/KantanShindan01.php';
  console.log(`📹 記録開始: ${startUrl}`);
  
  ws.send(JSON.stringify({
    type: 'recording:start',
    payload: { url: startUrl }
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.type === 'log') {
    const { level, message } = msg.payload;
    console.log(`[${level.toUpperCase()}] ${message}`);
  }
  
  if (msg.type === 'recording:page-collected') {
    const page = msg.payload;
    console.log('\n📄 ページ収集完了:');
    console.log(`  URL: ${page.url}`);
    console.log(`  Title: ${page.title}`);
    console.log(`  Fields: ${page.fields?.length || 0}個`);
    console.log(`  SubmitSelector: ${page.submitSelector || '(なし)'}`);
    console.log(`  SubmitText: ${page.submitText || '(なし)'}`);
    
    // ボタンが検出できたかどうか
    if (page.submitSelector) {
      console.log('\n✅ 送信ボタン検出成功!');
    } else {
      console.log('\n❌ 送信ボタン未検出 - 修正が必要');
    }
    
    // 10秒後に記録停止
    setTimeout(() => {
      console.log('\n⏹️ 記録停止...');
      ws.send(JSON.stringify({ type: 'recording:stop', payload: {} }));
      setTimeout(() => {
        ws.close();
        process.exit(0);
      }, 2000);
    }, 5000);
  }
  
  if (msg.type === 'recording:error') {
    console.error('❌ エラー:', msg.payload.message);
    ws.close();
    process.exit(1);
  }
});

ws.on('error', (err) => {
  console.error('WebSocketエラー:', err.message);
  process.exit(1);
});

// 60秒タイムアウト
setTimeout(() => {
  console.log('⏰ タイムアウト');
  ws.close();
  process.exit(1);
}, 60000);
