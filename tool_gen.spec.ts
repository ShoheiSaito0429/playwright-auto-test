import { test } from 'playwright/test';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PUBLIC_DIR = '/app/public/zenrosai';
const BASE_URL = 'https://www.zenrosai.coop/ss/kakekin/mycar/202111';

test('tool generated: zenrosai full flow', async ({ page }) => {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  // 古いスクリーンショットを削除
  fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.png')).forEach(f => fs.unlinkSync(path.join(PUBLIC_DIR, f)));
  let seq = 0;
  const snap = async (label) => {
    seq++;
    const file = path.join(PUBLIC_DIR, String(seq).padStart(3,'0') + '_' + label + '.png');
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    console.log('[SNAP ' + seq + '] ' + label + ' | ' + page.url().split('/').pop().split('?')[0]);
  };

  // チケット取得
  const out = execSync('curl -s -L "' + BASE_URL + '/shinki01.php" 2>/dev/null').toString();
  const m = out.match(/ticket=([a-f0-9]+)/);
  const ticket = m ? m[1] : '';
  console.log('TICKET:', ticket);

  await page.goto(BASE_URL + '/shinki01.php?ticket=' + ticket, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await snap('shinki01_初期');

  // [1] click: a.s-not_member
  await page.evaluate(() => { document.querySelector("a.s-not_member")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("a_s_not_member");

  // [2] radio: [name="s-car_type"] = 1
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"s-car_type\"][value=\"1\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [3] radio: [name="s-has_current"] = 2
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"s-has_current\"][value=\"2\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [4] click: a.c-font-strong.c-next
  await page.evaluate(() => { document.querySelector("a.c-font-strong.c-next")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("a_c_font_strong_c_next");

  // [5] click: a.c-font-strong.c-next
  await page.evaluate(() => { document.querySelector("a.c-font-strong.c-next")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("a_c_font_strong_c_next");

  // [6] select: [name="s_year"] = 2026
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"s_year\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"s_year\"]", "2026", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [7] select: [name="s_month"] = 03
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"s_month\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"s_month\"]", "03", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [8] select: [name="s_date"] = 15
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"s_date\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"s_date\"]", "15", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [9] radio: [name="has_multi"] = 2
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"has_multi\"][value=\"2\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [10] radio: [name="if_condition"] = 2
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"if_condition\"][value=\"2\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [11] radio: [name="is_maika"] = 1
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"is_maika\"][value=\"1\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [12] radio: [name="chiikiwaribiki"] = 11
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"chiikiwaribiki\"][value=\"11\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [13] click: a.m-joken_next_btn
  await page.evaluate(() => { document.querySelector("a.m-joken_next_btn")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("a_m_joken_next_btn");

  // [14] radio: [name="rel_driver"] = 1
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"rel_driver\"][value=\"1\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [15] radio: [name="who_drive"] = 4
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"who_drive\"][value=\"4\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [16] radio: [name="okosama"] = 2
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"okosama\"][value=\"2\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [17] select: [name="b_year"] = 1990
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"b_year\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"b_year\"]", "1990", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [18] select: [name="b_month"] = 01
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"b_month\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"b_month\"]", "01", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [19] select: [name="b_date"] = 01
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"b_date\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"b_date\"]", "01", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [20] click: a.m-joken_next_btn
  await page.evaluate(() => { document.querySelector("a.m-joken_next_btn")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("a_m_joken_next_btn");

  // [21] click: a[href="#q_sub_type_plate"]
  await page.evaluate(() => { document.querySelector("a[href=\"#q_sub_type_plate\"]")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("a_href___q_sub_type_plate__");

  // [22] radio: [name="s-type_plate"] = 1
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"s-type_plate\"][value=\"1\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [23] click: #q_sub_type_plate .c-next
  await page.evaluate(() => { document.querySelector("#q_sub_type_plate .c-next")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("_q_sub_type_plate__c_next");

  // [24] select: [name="first_year"] = 2020
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"first_year\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"first_year\"]", "2020", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [25] select: [name="first_month"] = 01
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"first_month\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"first_month\"]", "01", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [26] click: a[href="#q_sub_katashiki_maker"]
  await page.evaluate(() => { document.querySelector("a[href=\"#q_sub_katashiki_maker\"]")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("a_href___q_sub_katashiki_maker");

  // [27] select: #s-maker = 0102142196142214142192
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "#s-maker", { timeout: 5000 }).catch(() => {});
  await page.selectOption("#s-maker", "0102142196142214142192", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [28] select: #s-shamei = 0102173071082142212142216142189
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "#s-shamei", { timeout: 5000 }).catch(() => {});
  await page.selectOption("#s-shamei", "0102173071082142212142216142189", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [29] radio: [name="s-katashiki"][value="0102173GXPA16#1#1"] = 0102173GXPA16#1#1
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"s-katashiki\"][value=\"0102173GXPA16#1#1\"][value=\"0102173GXPA16#1#1\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [30] click: #q_sub_katashiki_maker .c-next
  await page.evaluate(() => { document.querySelector("#q_sub_katashiki_maker .c-next")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("_q_sub_katashiki_maker__c_next");

  // [31] select: [name="expire_year"] = 2027
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"expire_year\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"expire_year\"]", "2027", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [32] select: [name="expire_month"] = 01
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"expire_month\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"expire_month\"]", "01", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [33] select: [name="expire_date"] = 01
  await page.waitForFunction(sel => document.querySelector(sel)?.options?.length >= 2, "[name=\"expire_date\"]", { timeout: 5000 }).catch(() => {});
  await page.selectOption("[name=\"expire_date\"]", "01", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // [34] click: a.m-joken_next_btn
  await page.evaluate(() => { document.querySelector("a.m-joken_next_btn")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("a_m_joken_next_btn");

  // [35] radio: [name="sharyohosho_futaikibo"] = 1
  await page.evaluate(() => {
    const el = document.querySelector("[name=\"sharyohosho_futaikibo\"][value=\"1\"]");
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  // [36] click: a.m-joken_next_btn
  await page.evaluate(() => { document.querySelector("a.m-joken_next_btn")?.click(); });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap("a_m_joken_next_btn");

  await snap('最終結果');
  console.log('完了:', seq, '枚');
  console.log('URL:', page.url());
});