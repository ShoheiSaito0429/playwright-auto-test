import { chromium } from 'playwright';

const START_URL = 'https://www.zenrosai.coop/ss/kakekin/kantanshindan/KantanShindan01.php?ticket=481f3d3c957ae4c597f1b09e5c308bf6';

async function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${msg}`);
}

async function fillRadio(page: any, selector: string, value: string) {
  const specificSelector = `${selector}[value="${value}"]`;
  await page.evaluate(({ sel, val, groupSel }: any) => {
    let radio = document.querySelector(sel) as HTMLInputElement | null;
    if (!radio) {
      const radios = Array.from(document.querySelectorAll(groupSel)) as HTMLInputElement[];
      radio = radios.find(r => r.value === val) || null;
    }
    if (!radio) return false;
    radio.disabled = false;
    radio.checked = true;
    ['click', 'input', 'change'].forEach(evt => {
      radio!.dispatchEvent(new Event(evt, { bubbles: true }));
    });
    const label = radio.id ? document.querySelector(`label[for="${radio.id}"]`) as HTMLElement : null;
    if (label) label.click();
    return true;
  }, { sel: specificSelector, val: value, groupSel: selector });
}

async function fillText(page: any, selector: string, value: string) {
  await page.evaluate(({ sel, val }: any) => {
    const el = document.querySelector(sel) as HTMLInputElement | null;
    if (!el) return false;
    el.focus();
    el.value = val;
    ['input', 'change', 'blur'].forEach(evt => el.dispatchEvent(new Event(evt, { bubbles: true })));
    return true;
  }, { sel: selector, val: value });
  await page.keyboard.press('Escape').catch(() => {});
}

// 改良版: 全ての未回答ラジオボタンを探して回答（hidden inputも対応）
async function answerAllVisibleQuestions(page: any): Promise<{answered: number, details: string[]}> {
  const result = await page.evaluate(() => {
    const details: string[] = [];
    const radioGroups = new Map<string, HTMLInputElement[]>();
    
    // 全てのラジオボタンをグループ化（hiddenも含む）
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    for (const radio of radios) {
      const name = radio.name;
      if (!name) continue;
      if (!radioGroups.has(name)) {
        radioGroups.set(name, []);
      }
      radioGroups.get(name)!.push(radio);
    }
    
    details.push(`ラジオグループ数: ${radioGroups.size}`);
    
    let count = 0;
    for (const [name, group] of radioGroups) {
      const anyChecked = group.some(r => r.checked);
      details.push(`  ${name}: ${group.length}個, 選択済み=${anyChecked}`);
      
      if (anyChecked) continue;
      
      // 最初のラジオを選択（value="1" を優先）
      const radioToSelect = group.find(r => r.value === '1') || group[0];
      if (radioToSelect) {
        // hidden でも強制的に checked
        radioToSelect.disabled = false;
        radioToSelect.checked = true;
        
        // イベント発火
        ['mousedown', 'mouseup', 'click', 'input', 'change'].forEach(evt => {
          const event = evt.startsWith('mouse') 
            ? new MouseEvent(evt, { bubbles: true, cancelable: true })
            : new Event(evt, { bubbles: true, cancelable: true });
          radioToSelect.dispatchEvent(event);
        });
        
        // ラベルも探してクリック
        let label: HTMLElement | null = null;
        if (radioToSelect.id) {
          label = document.querySelector(`label[for="${radioToSelect.id}"]`);
        }
        if (!label) {
          label = radioToSelect.closest('label');
        }
        if (!label) {
          // 親要素や兄弟要素のラベルを探す
          const parent = radioToSelect.parentElement;
          if (parent) {
            label = parent.querySelector('label') || parent.closest('label');
          }
        }
        
        if (label) {
          details.push(`    → ラベルクリック: ${label.textContent?.trim().substring(0, 20)}`);
          label.click();
          label.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } else {
          details.push(`    → ラベルなし、direct checked`);
        }
        
        count++;
      }
    }
    
    return { answered: count, details };
  });
  
  return result;
}

async function autoClickSubmit(page: any): Promise<boolean> {
  const textPatterns = ['次へ', '進む', '確認', '送信', '完了', 'スタート', '診断', '開始', '結果'];
  
  const selector = await page.evaluate((patterns: string[]) => {
    const allClickables = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')) as HTMLElement[];
    for (const btn of allClickables) {
      if (btn.offsetParent === null) continue;
      if ((btn as any).disabled) continue;
      if (btn.classList.contains('disabled')) continue;
      // グレーアウトチェック
      const style = getComputedStyle(btn);
      if (style.opacity && parseFloat(style.opacity) < 0.5) continue;
      
      const text = btn.textContent?.trim().toLowerCase() || '';
      for (const keyword of patterns) {
        if (text.includes(keyword.toLowerCase())) {
          const id = btn.id ? `#${btn.id}` : null;
          const tagName = btn.tagName.toLowerCase();
          const textContent = btn.textContent?.trim().substring(0, 20) || '';
          return id || `${tagName}:has-text("${textContent}")`;
        }
      }
    }
    return null;
  }, textPatterns);
  
  if (selector) {
    log(`🎯 ${selector}`);
    try {
      await page.locator(selector).first().click({ force: true });
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      return true;
    } catch (err: any) {
      log(`❌ ${err.message}`);
      return false;
    }
  }
  return false;
}

async function main() {
  log('🚀 テスト開始');
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    log(`✅ ${await page.title()}`);
    
    // Step 2
    log('\n--- Step 2 ---');
    await fillText(page, '#birth_m', '1');
    await fillText(page, '#birth_d', '15');
    await page.locator('#birth_y').selectOption('1990');
    await fillRadio(page, 'input[type="radio"][name="fHSYOKAISHI"]', '1');
    await fillRadio(page, 'input[type="radio"][name="sSEX1"]', '1');
    await fillRadio(page, 'input[type="radio"][name="sKenko"]', '2');
    await fillRadio(page, 'input[type="radio"][name="sHaigusha"]', '1');
    await fillRadio(page, 'input[type="radio"][name="sKodomo"]', '1');
    log('✅ 入力完了');
    
    await autoClickSubmit(page);
    log(`📍 ${page.url().includes('02') ? 'ページ2' : 'ページ1'}`);
    
    // Page 2: Answer ALL questions
    log('\n--- ページ2: 質問回答ループ ---');
    
    for (let i = 0; i < 15; i++) {
      // 未回答を探して回答
      const {answered, details} = await answerAllVisibleQuestions(page);
      for (const d of details) log(d);
      
      if (answered > 0) {
        log(`✅ ${answered}個回答`);
        await page.waitForTimeout(1500);
      }
      
      // 保険選択フィールドが出たか確認
      const rbtkin01 = await page.locator('select[name="rbtkin_01"]').count();
      if (rbtkin01 > 0) {
        log('🎉 保険選択フィールド表示！');
        break;
      }
      
      // 送信ボタン
      const clicked = await autoClickSubmit(page);
      if (!clicked && answered === 0) {
        log('⚠️ 進めない - スクリーンショット保存');
        await page.screenshot({ path: '/tmp/test_stuck.png', fullPage: true });
        
        // デバッグ: ページのHTML構造を出力
        const html = await page.evaluate(() => document.body.innerHTML.substring(0, 2000));
        log('--- HTML (先頭2000文字) ---');
        log(html);
        break;
      }
      
      await page.waitForTimeout(1000);
    }
    
    // Final
    log('\n--- 最終確認 ---');
    log(`📍 ${page.url()}`);
    const rbtkin01 = await page.locator('select[name="rbtkin_01"]').count();
    const chkKodomo = await page.locator('input[name="chk_kodomo"]').count();
    log(`rbtkin_01: ${rbtkin01 > 0 ? '✅' : '❌'}, chk_kodomo: ${chkKodomo > 0 ? '✅' : '❌'}`);
    
    await page.screenshot({ path: '/tmp/test_final.png', fullPage: true });
    log('✅ 完了');
    
  } catch (err: any) {
    log(`❌ ${err.message}`);
  } finally {
    await browser.close();
  }
}

main();
