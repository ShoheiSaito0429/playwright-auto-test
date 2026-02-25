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
    const byValue = page.locator(specificSelector);

    if (await byValue.count() > 0) {
      // 対象ラジオを直接有効化
      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (!el) return;
        el.disabled = false;
        el.removeAttribute('disabled');
        const parent = el.parentElement;
        if (parent && getComputedStyle(parent).display === 'none') parent.style.display = '';
      }, specificSelector);
      try {
        await byValue.first().check({ force: true });
      } catch {
        await byValue.first().click({ force: true });
      }
      return;
    }

    // value が一致するものがない場合はグループ先頭を選択
    try {
      await page.locator(selector).first().check({ force: true });
    } catch {
      await page.locator(selector).first().click({ force: true });
    }
  }

  private async selectOption(page: Page, selector: string, value: string): Promise<void> {
    const el = page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: 5000 });
    try {
      await el.selectOption({ value });
    } catch {
      await el.selectOption({ label: value });
    }
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
