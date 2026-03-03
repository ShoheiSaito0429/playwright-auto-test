import type { Page } from 'playwright';
import path from 'path';
import type { FieldValue } from '../types.js';

/**
 * 入力タイプ別の操作ハンドラ
 */
export class InputHandler {
  async fillField(page: Page, field: FieldValue): Promise<void> {
    // disabled/hidden のフィールドを操作前に有効化する
    await this.ensureFieldEnabled(page, field.selector);
    
    switch (field.type) {
      case 'text': case 'textarea': case 'password':
      case 'email': case 'number': case 'date': case 'tel': case 'url':
      case 'datetime-local': case 'time': case 'month': case 'week':
        await this.fillText(page, field.selector, field.value);
        break;
      case 'range':
        await this.setRange(page, field.selector, field.value);
        break;
      case 'color':
        await this.setColor(page, field.selector, field.value);
        break;
      case 'radio':
        await this.selectRadio(page, field.selector, field.value);
        break;
      case 'select':
        await this.selectOption(page, field.selector, field.value);
        break;
      case 'checkbox':
        await this.setCheckbox(page, field.selector, field.value === 'true' || field.value === '1');
        break;
      case 'file':
        await this.uploadFile(page, field.selector, field.filePath || field.value);
        break;
      case 'click_js':
        // JS直接クリック（モーダルトリガー・決定ボタン等）
        await page.evaluate((sel: string) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) el.click();
        }, field.selector);
        await page.waitForTimeout(Number(field.value) || 800);
        break;
      case 'wait':
        await page.waitForTimeout(Number(field.value) || 500);
        break;
      case 'wait_for':
        // codegen と同じ waitForFunction でオプション/要素が出るまで待つ
        try {
          await page.waitForFunction(
            (sel: string) => {
              const el = document.querySelector(sel) as HTMLSelectElement | null;
              if (!el) return false;
              if (el.tagName === 'SELECT') return el.options.length >= 2;
              // radio/checkbox: 要素が存在すればOK
              return document.querySelectorAll(sel).length > 0;
            },
            field.selector,
            { timeout: 12000 }
          ).catch(() => {});
        } catch { /* タイムアウトしても続行 */ }
        break;
    }
  }

  /**
   * 動的にレンダリングされる要素対応：
   * count() === 0 の場合は最大 timeoutMs ms ポーリングして現れるのを待つ。
   * 画面遷移後に JS で追加される select/checkbox/radio などに効果的。
   */
  private async waitForCount(page: Page, selector: string, timeoutMs = 3000): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const count = await page.locator(selector).count();
      if (count > 0) return count;
      await page.waitForTimeout(250);
    }
    return 0;
  }

  private async fillText(page: Page, selector: string, value: string): Promise<void> {
    const count = await this.waitForCount(page, selector);
    if (count === 0) throw new Error(`element not found: ${selector}`);

    const el = page.locator(selector).first();

    // JS直接操作（クリック不要 → ポップアップ開かない）
    const ok = await page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) return false;
      el.focus();
      el.value = val;
      ['input', 'change', 'blur'].forEach(evt =>
        el.dispatchEvent(new Event(evt, { bubbles: true }))
      );
      return true;
    }, { sel: selector, val: value });

    // ポップアップが開いていれば閉じる
    await page.keyboard.press('Escape').catch(() => {});

    if (!ok) {
      // フォールバック: Playwright fill()
      await el.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
      await el.fill(value);
    }
  }

  private async selectRadio(page: Page, selector: string, value: string): Promise<void> {
    // 要素が現れるまで最大3秒待つ（動的レンダリング対応）
    const count = await this.waitForCount(page, selector);
    if (count === 0) throw new Error(`radio not found: ${selector}`);

    const specificSelector = `${selector}[value="${value}"]`;

    // ラジオボタンのIDを取得（ラベルクリック用）
    const radioId = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      return el?.id || null;
    }, specificSelector).catch(() => null);

    // ① まずPlaywrightで可視ラベルをクリック（カスタムUIの視覚的状態を更新するのに最も確実）
    let labelClicked = false;
    if (radioId) {
      const labelSel = `label[for="${radioId}"]`;
      const labelCount = await page.locator(labelSel).count().catch(() => 0);
      if (labelCount > 0) {
        try {
          // 可視の場合はPlaywright実クリック（マウスイベント座標付き）
          await page.locator(labelSel).first().click({ timeout: 2000 });
          labelClicked = true;
        } catch {
          // 非表示の場合はforce click
          try {
            await page.locator(labelSel).first().click({ force: true, timeout: 1000 });
            labelClicked = true;
          } catch { /* ラベルクリック失敗 */ }
        }
      }
    }

    // ラベルクリックが成功した場合でも、checkedを確認してからJS補完
    const afterLabelCheck = radioId ? await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      return el?.checked ?? false;
    }, specificSelector).catch(() => false) : false;

    if (labelClicked && afterLabelCheck) return; // ラベルクリックで完結

    // ② JS経由でchecked + イベント発火（フォールバック・補完）
    const jsResult = await page.evaluate(({ sel, val, groupSel }) => {
      // 値指定で検索
      let radio = document.querySelector(sel) as HTMLInputElement | null;
      // 見つからない場合はグループ内から value でマッチ
      if (!radio) {
        const radios = Array.from(document.querySelectorAll(groupSel)) as HTMLInputElement[];
        radio = radios.find(r => r.value === val) || radios[0] || null;
      }
      if (!radio) return { ok: false, reason: 'element not found' };

      // 有効化
      radio.disabled = false;
      radio.removeAttribute('disabled');

      // checked をセット
      radio.checked = true;

      // イベントを全種類発火（jQuery/カスタムJS対応）
      ['click', 'mousedown', 'mouseup', 'input', 'change'].forEach(evtName => {
        const evt = evtName.startsWith('mouse')
          ? new MouseEvent(evtName, { bubbles: true, cancelable: true })
          : new Event(evtName, { bubbles: true, cancelable: true });
        radio!.dispatchEvent(evt);
      });

      // 関連ラベルもJSクリック（スタイル変更用のJSトリガー）
      const id = radio.id;
      const label = id
        ? document.querySelector(`label[for="${id}"]`) as HTMLElement | null
        : radio.closest('label') as HTMLElement | null;
      if (label) {
        label.click();
        label.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }

      return { ok: true, labelClicked: !!label, value: radio.value };
    }, { sel: specificSelector, val: value, groupSel: selector });

    if (jsResult.ok) return;

    // ③ 最終手段: Playwright check/click
    const locator = page.locator(specificSelector).first();
    if (await locator.count() > 0) {
      try { await locator.check({ force: true }); return; } catch { /* fall through */ }
      try { await locator.click({ force: true }); return; } catch { /* fall through */ }
    }

    // グループ先頭
    await page.locator(selector).first().click({ force: true }).catch(() => {});
  }

  private async selectOption(page: Page, selector: string, value: string): Promise<void> {
    // 動的レンダリング対応: 要素が現れるまで最大3秒待つ
    const count = await this.waitForCount(page, selector);
    if (count === 0) throw new Error(`element not found: ${selector}`);

    const el = page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});

    // 1. value属性で選択
    try { await el.selectOption({ value }); return; } catch { /* fall through */ }

    // 2. ラベルテキストで選択
    try { await el.selectOption({ label: value }); return; } catch { /* fall through */ }

    // 3. JS直接操作（カスタムselect対応）
    const jsOk = await page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel) as HTMLSelectElement | null;
      if (!el) return false;
      // value一致
      const opt = Array.from(el.options).find(o => o.value === val || o.text === val || o.text.includes(val));
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, { sel: selector, val: value });

    if (!jsOk) throw new Error(`select option not found: value="${value}" in selector="${selector}"`);
  }

  private async setCheckbox(page: Page, selector: string, checked: boolean): Promise<void> {
    // 動的レンダリング対応: 要素が現れるまで最大3秒待つ
    const count = await this.waitForCount(page, selector);
    if (count === 0) throw new Error(`element not found: ${selector}`);

    const el = page.locator(selector).first();
    try {
      await el.waitFor({ state: 'attached', timeout: 2000 });
      checked ? await el.check({ force: true }) : await el.uncheck({ force: true });
    } catch {
      checked ? await el.check({ force: true }) : await el.click({ force: true });
    }
  }

  private async uploadFile(page: Page, selector: string, filePath: string): Promise<void> {
    const el = page.locator(selector).first();
    await el.setInputFiles(path.resolve(filePath));
  }

  private async setRange(page: Page, selector: string, value: string): Promise<void> {
    const count = await this.waitForCount(page, selector);
    if (count === 0) throw new Error(`element not found: ${selector}`);

    await page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel: selector, val: value });
  }

  private async setColor(page: Page, selector: string, value: string): Promise<void> {
    const count = await this.waitForCount(page, selector);
    if (count === 0) throw new Error(`element not found: ${selector}`);

    await page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel: selector, val: value });
  }

  /**
   * disabled / hidden のフィールドを操作可能にする
   */
  private async ensureFieldEnabled(page: Page, selector: string): Promise<void> {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
      if (!el) return;

      // disabled を解除
      if (el.disabled) {
        el.disabled = false;
        el.removeAttribute('disabled');
      }
      // aria-disabled を解除
      if (el.getAttribute('aria-disabled') === 'true') {
        el.setAttribute('aria-disabled', 'false');
      }
      // 親の fieldset が disabled なら解除
      const fieldset = el.closest('fieldset');
      if (fieldset && fieldset.disabled) {
        fieldset.disabled = false;
      }
      // display:none の場合は表示する
      // ただし radio/checkbox はカスタムUIで意図的に隠されている場合があるためスキップ
      const inputType = (el as HTMLInputElement).type;
      const isCustomUiInput = inputType === 'radio' || inputType === 'checkbox';
      if (!isCustomUiInput) {
        const style = getComputedStyle(el);
        if (style.display === 'none') {
          (el as HTMLElement).style.display = '';
        }
        // 親要素が非表示の場合（1階層のみ対応）
        const parent = el.parentElement;
        if (parent && getComputedStyle(parent).display === 'none') {
          parent.style.display = '';
        }
      }
      // readonly を解除
      if ((el as HTMLInputElement).readOnly) {
        (el as HTMLInputElement).readOnly = false;
      }
    }, selector).catch(() => {
      // ページ遷移中は無視
    });

    await page.waitForTimeout(100);
  }
}
