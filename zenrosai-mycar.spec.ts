/**
 * zenrosai.coop マイカー共済 新規申込フロー テストケース
 *
 * ケース: 普通乗用車3ナンバー / トヨタ GRヤリス GXPA16
 * 補償開始日: 2026/3/15
 */
import { test } from '@playwright/test';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const PUBLIC_DIR = '/app/public/zenrosai';
const BASE_URL = 'https://www.zenrosai.coop/ss/kakekin/mycar/202111';

async function fetchTicket(): Promise<string> {
  
  const out = execSync(
    `curl -s -L -c /tmp/zenrosai_cookie.txt "${BASE_URL}/shinki01.php" 2>/dev/null`
  ).toString();
  const m = out.match(/ticket=([a-f0-9]+)/);
  if (!m) throw new Error('チケット取得失敗');
  return m[1];
}

test('zenrosai マイカー共済 新規申込 通し確認', async ({ page }) => {
  // 出力ディレクトリ
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  let seq = 0;
  const snap = async (label: string) => {
    seq++;
    const name = `${String(seq).padStart(3, '0')}_${label}.png`;
    const filePath = path.join(PUBLIC_DIR, name);
    await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
    console.log(`[SNAP ${seq}] ${label} | ${page.url().split('?')[0].split('/').pop()}`);
    return name;
  };

  const closeAlert = async () => {
    await page.evaluate(() => {
      (document.querySelector('#popup_alert .js-popup-close') as HTMLElement)?.click();
    }).catch(() => {});
    await page.waitForTimeout(200);
  };

  const clickFormNext = async () => {
    await closeAlert();
    const btn = page.locator('a.m-joken_next_btn, a.c-font-strong.c-next').first();
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(200);
    await btn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
  };

  // =========================================
  // Step 0: チケット取得 & shinki01 表示
  // =========================================
  const ticket = await fetchTicket();
  console.log('TICKET:', ticket);

  await page.goto(`${BASE_URL}/shinki01.php?ticket=${ticket}`, { waitUntil: 'networkidle' });
  await snap('shinki01_初期');

  // =========================================
  // Step 1: shinki01 → shinki01_1 (モーダル)
  //   車種: 四輪自動車、現保険: いいえ
  // =========================================
  await page.locator('a.js-mypage_modal_mitsumori').click({ force: true });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const r = (n: string, v: string) => {
      const el = document.querySelector(`input[name="${n}"][value="${v}"]`) as HTMLInputElement;
      if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    r('s-car_type', '1');   // 四輪自動車
    r('s-has_current', '2'); // 現保険なし
  });
  await page.waitForTimeout(300);
  await snap('shinki01_入力済み');

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 12000 }).catch(() => {}),
    page.evaluate(() => { (document.querySelector('a.c-font-strong.c-next') as HTMLElement)?.click(); }),
  ]);
  await snap('shinki01_1_表示');

  // =========================================
  // Step 2: shinki01_1 → shinki02
  // =========================================
  const btn01_1 = page.locator('a.c-font-strong.c-next').first();
  await btn01_1.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {}),
    btn01_1.click({ timeout: 5000 }),
  ]);
  await page.waitForTimeout(400);
  await snap('shinki02_step1_表示');

  // =========================================
  // Step 3: shinki02 STEP1 — 補償条件
  //   補償開始日: 2026/3/15、その他いいえ系
  // =========================================
  await page.selectOption('select[name="s_year"]', '2026');
  await page.waitForFunction(
    () => (document.querySelector('select[name="s_month"]') as HTMLSelectElement)?.options.length >= 2,
    { timeout: 8000 }
  ).catch(() => {});
  await page.selectOption('select[name="s_month"]', '03');
  await page.waitForFunction(
    () => (document.querySelector('select[name="s_date"]') as HTMLSelectElement)?.options.length >= 2,
    { timeout: 8000 }
  ).catch(() => {});
  await page.selectOption('select[name="s_date"]', '15');
  await page.evaluate(() => {
    const r = (n: string, v: string) => {
      const el = document.querySelector(`input[name="${n}"][value="${v}"]`) as HTMLInputElement;
      if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    r('has_multi', '2');       // 他保険なし
    r('if_condition', '2');    // 条件なし
    r('is_maika', '1');        // マイカー
    r('chiikiwaribiki', '11'); // 沖縄県以外
  });
  await page.waitForTimeout(400);
  await snap('shinki02_step1_入力済み');
  await clickFormNext();

  // =========================================
  // Step 4: shinki02 STEP2 — 運転者情報
  //   ラジオ: おまかせ、生年月日: 適当
  // =========================================
  await page.evaluate(() => {
    document.querySelectorAll('input[type="radio"]').forEach(r => {
      const radio = r as HTMLInputElement;
      if ((radio as HTMLElement).offsetParent !== null &&
          !document.querySelector(`input[name="${radio.name}"]:checked`)) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
  await page.waitForTimeout(200);
  await page.selectOption('select[name="b_year"]', { index: 10 }).catch(() => {});
  await page.waitForFunction(
    () => (document.querySelector('select[name="b_month"]') as HTMLSelectElement)?.options.length >= 2,
    { timeout: 5000 }
  ).catch(() => {});
  await page.selectOption('select[name="b_month"]', { index: 1 }).catch(() => {});
  await page.waitForFunction(
    () => (document.querySelector('select[name="b_date"]') as HTMLSelectElement)?.options.length >= 2,
    { timeout: 5000 }
  ).catch(() => {});
  await page.selectOption('select[name="b_date"]', { index: 1 }).catch(() => {});
  await page.waitForTimeout(200);
  await snap('shinki02_step2_入力済み');
  await clickFormNext();
  await closeAlert();

  // =========================================
  // Step 5: shinki02 STEP3 — 車情報
  //   車種: 普通乗用車3ナンバー
  //   メーカー: トヨタ / 車名: GRヤリス / 型式: GXPA16
  //   初度登録: 2020/01、車検満了: おまかせ
  // =========================================
  await snap('shinki02_step3_表示');

  // 車種モーダル
  await page.locator('a[href="#q_sub_type_plate"]').first().click({ force: true });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const el = document.querySelector('input[name="s-type_plate"][value="1"]') as HTMLInputElement;
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(200);
  await page.locator('#q_sub_type_plate .c-next').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);

  // 初度登録年月
  await page.selectOption('select[name="first_year"]', '2020').catch(() => {});
  await page.waitForFunction(
    () => (document.querySelector('select[name="first_month"]') as HTMLSelectElement)?.options.length >= 2,
    { timeout: 5000 }
  ).catch(() => {});
  await page.selectOption('select[name="first_month"]', { index: 1 }).catch(() => {});
  await page.waitForTimeout(400);

  // メーカー・車名モーダル: トヨタ → GRヤリス → GXPA16
  await page.locator('a[href="#q_sub_katashiki_maker"]').first().click({ force: true });
  await page.waitForTimeout(800);
  await snap('メーカー選択モーダル');

  await page.selectOption('#s-maker', '0102142196142214142192'); // トヨタ
  await page.waitForTimeout(1200);
  await page.selectOption('#s-shamei', '0102173071082142212142216142189'); // GRヤリス
  await page.waitForTimeout(2000);
  await snap('GRヤリス型式一覧');

  // GXPA16 ラジオボタン選択
  await page.evaluate(() => {
    const radios = Array.from(
      document.querySelectorAll('#q_sub_katashiki_maker input[type="radio"]')
    );
    const gxpa = radios.find(r => r.closest('tr')?.textContent?.includes('GXPA16')) as HTMLInputElement;
    if (gxpa) {
      gxpa.checked = true;
      gxpa.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.waitForTimeout(400);
  await page.locator('#q_sub_katashiki_maker .c-next').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap('GXPA16選択後');

  // 車検満了日
  await page.selectOption('select[name="expire_year"]', { index: 1 }).catch(() => {});
  await page.waitForFunction(
    () => (document.querySelector('select[name="expire_month"]') as HTMLSelectElement)?.options.length >= 2,
    { timeout: 5000 }
  ).catch(() => {});
  await page.selectOption('select[name="expire_month"]', { index: 1 }).catch(() => {});
  await page.waitForFunction(
    () => (document.querySelector('select[name="expire_date"]') as HTMLSelectElement)?.options.length >= 2,
    { timeout: 5000 }
  ).catch(() => {});
  await page.selectOption('select[name="expire_date"]', { index: 1 }).catch(() => {});
  await page.waitForTimeout(300);
  await snap('shinki02_step3_入力済み');

  await clickFormNext();
  console.log('shinki02完了 → 次:', page.url().split('?')[0].split('/').pop());
  await snap('shinki03_表示');


  // =========================================
  // Step 6: shinki03 — お車について
  //   車両損害補償: はい
  // =========================================
  await page.evaluate(() => {
    const r = (n: string, v: string) => {
      const el = document.querySelector(`input[name="${n}"][value="${v}"]`) as HTMLInputElement;
      if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    r('sharyohosho_futaikibo', '1'); // 車両損害補償: はい（付帯希望）
  });
  await page.waitForTimeout(500);
  await snap('shinki03_入力済み');
  await clickFormNext();
  await page.waitForTimeout(2000);
  await snap('shinki04_見積もり結果');

  // =========================================
  // 結果サマリ
  // =========================================
  const screenshots = fs.readdirSync(PUBLIC_DIR)
    .filter(f => f.endsWith('.png'))
    .sort()
    .map(f => `http://100.65.45.31:3200/zenrosai/${f}`);
  console.log('\n=== キャプチャ一覧 ===');
  screenshots.forEach(s => console.log(s));
  console.log(`合計: ${seq}枚`);
});
