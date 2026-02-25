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
        await this.fillText(page, field.selector, field.value);
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
    }
  }

  private async fillText(page: Page, selector: string, value: string): Promise<void> {
    const el = page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: 5000 });
    await el.click();
    await el.fill('');
    await el.fill(value);
  }

  private async selectRadio(page: Page, selector: string, value: string): Promise<void> {
    const specificSelector = `${selector}[value="${value}"]`;

    // --- JS経由で確実に選択（カスタムUIサイト対応） ---
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

      // 関連ラベルもクリック（スタイル変更用のJSトリガー）
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

    // JS経由で失敗した場合は Playwright の click fallback
    const locator = page.locator(specificSelector).first();
    if (await locator.count() > 0) {
      try { await locator.check({ force: true }); return; } catch { /* fall through */ }
      try { await locator.click({ force: true }); return; } catch { /* fall through */ }
    }

    // 最終手段: グループ先頭
    await page.locator(selector).first().click({ force: true }).catch(() => {});
  }

  private async selectOption(page: Page, selector: string, value: string): Promise<void> {
    const el = page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: 5000 });

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
    const el = page.locator(selector).first();
    try {
      await el.waitFor({ state: 'attached', timeout: 5000 });
      checked ? await el.check({ force: true }) : await el.uncheck({ force: true });
    } catch {
      checked ? await el.check({ force: true }) : await el.click({ force: true });
    }
  }

  private async uploadFile(page: Page, selector: string, filePath: string): Promise<void> {
    const el = page.locator(selector).first();
    await el.setInputFiles(path.resolve(filePath));
  }

  /**
   * disabled / hidden のフィールドを操作可能にする
   * ページのJSが依存関係を管理している場合、先にトリガーを操作する必要がある。
   * ここではフォールバックとして、DOM属性を直接変更して強制的に有効化する。
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
      const style = getComputedStyle(el);
      if (style.display === 'none') {
        (el as HTMLElement).style.display = '';
      }
      // 親要素が非表示の場合（1階層のみ対応）
      const parent = el.parentElement;
      if (parent && getComputedStyle(parent).display === 'none') {
        parent.style.display = '';
      }
      // readonly を解除
      if ((el as HTMLInputElement).readOnly) {
        (el as HTMLInputElement).readOnly = false;
      }
    }, selector);

    // 有効化後、少し待機してDOMの更新を待つ
    await page.waitForTimeout(100);
  }
}
