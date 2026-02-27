/**
 * ボタン検出ロジックのテスト
 * Usage: node test-button-detection.mjs [URL]
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function testButtonDetection(url) {
  console.log(`\n🧪 ボタン検出テスト: ${url}\n`);
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000); // JS実行待ち
    
    const result = await page.evaluate(() => {
      const textPattern = /次へ|進む|送信|確認|完了|登録|保存|スタート|開始|診断|申込|見積|ログイン|サインイン|submit|next|confirm|save|start|login|sign.?in/i;
      
      const results = {
        detected: [],
        hidden: [],
        disabled: [],
      };
      
      // 検出ロジック（browser-manager.ts と同等）
      const candidates = [
        // 1. type="submit"
        ...Array.from(document.querySelectorAll('button[type="submit"]')),
        ...Array.from(document.querySelectorAll('input[type="submit"]')),
        // 2. input[type="image"]
        ...Array.from(document.querySelectorAll('input[type="image"]')),
        // 3. javascript: リンク
        ...Array.from(document.querySelectorAll('a[href^="javascript:"]')),
        // 4. role="button"
        ...Array.from(document.querySelectorAll('[role="button"]')),
        // 5. onclick属性を持つdiv/span
        ...Array.from(document.querySelectorAll('div[onclick], span[onclick]')),
        // 6. テキストマッチのbutton
        ...Array.from(document.querySelectorAll('button')),
        // 7. テキストマッチのa
        ...Array.from(document.querySelectorAll('a')),
      ];
      
      const seen = new Set();
      
      for (const el of candidates) {
        if (seen.has(el)) continue;
        seen.add(el);
        
        const tagName = el.tagName.toLowerCase();
        const text = el.textContent?.trim().substring(0, 40) || '';
        const value = el.value || '';
        const className = el.className || '';
        const id = el.id || '';
        const href = el.getAttribute('href') || '';
        const onclick = el.getAttribute('onclick') || '';
        const role = el.getAttribute('role') || '';
        const type = el.getAttribute('type') || '';
        const disabled = el.disabled || el.getAttribute('disabled') !== null;
        
        // 表示チェック
        const style = window.getComputedStyle(el);
        const isHidden = style.display === 'none' || style.visibility === 'hidden';
        const isVisible = !isHidden && el.offsetWidth > 0 && el.offsetHeight > 0;
        
        // テキストマッチチェック
        const matchesText = textPattern.test(text + ' ' + value);
        
        const info = {
          tag: tagName,
          text: text.substring(0, 30),
          id: id || null,
          class: className ? className.substring(0, 30) : null,
          type: type || null,
          href: href ? href.substring(0, 40) : null,
          onclick: onclick ? 'yes' : null,
          role: role || null,
          disabled,
          visible: isVisible,
          matchesText,
        };
        
        if (disabled) {
          results.disabled.push(info);
        } else if (!isVisible) {
          results.hidden.push(info);
        } else if (
          type === 'submit' || 
          type === 'image' ||
          href?.startsWith('javascript:') ||
          role === 'button' ||
          onclick ||
          matchesText
        ) {
          results.detected.push(info);
        }
      }
      
      return results;
    });
    
    console.log('✅ 検出されたボタン候補:');
    if (result.detected.length === 0) {
      console.log('  (なし)');
    } else {
      result.detected.forEach((btn, i) => {
        const attrs = [];
        if (btn.type) attrs.push(`type=${btn.type}`);
        if (btn.href) attrs.push(`href=${btn.href}`);
        if (btn.onclick) attrs.push('onclick');
        if (btn.role) attrs.push(`role=${btn.role}`);
        if (btn.class) attrs.push(`class=${btn.class}`);
        console.log(`  [${i + 1}] <${btn.tag}> "${btn.text}" ${attrs.join(', ')}`);
      });
    }
    
    if (result.hidden.length > 0) {
      console.log('\n🙈 非表示のボタン:');
      result.hidden.forEach(btn => {
        console.log(`  <${btn.tag}> "${btn.text}"`);
      });
    }
    
    if (result.disabled.length > 0) {
      console.log('\n🚫 無効化されたボタン:');
      result.disabled.forEach(btn => {
        console.log(`  <${btn.tag}> "${btn.text}"`);
      });
    }
    
    console.log(`\n📊 合計: 検出=${result.detected.length}, 非表示=${result.hidden.length}, 無効=${result.disabled.length}`);
    
    return result;
  } finally {
    await browser.close();
  }
}

// テスト実行
const urls = process.argv.slice(2);

if (urls.length === 0) {
  // デフォルトテスト
  const testHtml = `file://${path.join(__dirname, 'public', 'test-buttons.html')}`;
  await testButtonDetection(testHtml);
  
  // 全労済サイト
  console.log('\n' + '='.repeat(60) + '\n');
  await testButtonDetection('https://www.zenrosai.coop/ss/kakekin/kantanshindan/KantanShindan01.php');
} else {
  for (const url of urls) {
    await testButtonDetection(url);
    console.log('\n' + '='.repeat(60) + '\n');
  }
}
