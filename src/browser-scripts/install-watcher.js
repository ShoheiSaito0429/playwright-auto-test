/**
 * MutationObserver + クリック監視 注入スクリプト
 * 純粋なJS（esbuildの__name注入を回避）
 */
(() => {
  if (window.__fieldWatcherInstalled) return;
  window.__fieldWatcherInstalled = true;

  let debounceTimer = null;

  const notify = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (typeof window.__fieldWatcherCallback === 'function') {
        window.__fieldWatcherCallback();
      }
    }, 800);
  };

  // クリックされたボタンを記録（送信ボタン検出用）
  const buildSelector = (el) => {
    if (!el) return '';
    if (el.id) return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      // 全クラスを結合して一意なセレクターにする（例: a.s-btn.s-not_member）
      const classes = el.className.trim().split(/\s+/).filter(Boolean);
      if (classes.length) return `${tag}.${classes.join('.')}`;
    }
    if (el.getAttribute('name')) return `${tag}[name="${el.getAttribute('name')}"]`;
    const text = el.textContent?.trim().substring(0, 20) || '';
    if (text) return `${tag}:has-text("${text}")`;
    return tag;
  };

  const isSubmitButton = (el) => {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' && el.type !== 'button') return true;
    if (tag === 'input' && ['submit', 'image'].includes(el.type)) return true;
    if (tag === 'a' && el.href?.startsWith('javascript:')) return true;
    if (el.getAttribute('role') === 'button') return true;
    if (el.classList?.contains('nextBtn') || el.classList?.contains('nextBtn2')) return true;
    // テキストマッチは button/a のみ（div/span などの大きなコンテナは除外して誤検出を防ぐ）
    if (tag === 'button' || tag === 'a') {
      const text = (el.textContent || '').toLowerCase();
      return /次へ|進む|送信|確認|完了|登録|スタート|開始|診断|申込|submit|next|confirm|start/.test(text);
    }
    return false;
  };

  document.addEventListener('click', (e) => {
    let el = e.target;
    // 親要素をたどってボタンを探す
    for (let i = 0; i < 5 && el; i++) {
      if (isSubmitButton(el)) {
        const selector = buildSelector(el);
        const text = el.textContent?.trim().substring(0, 30) || '';
        window.__lastClickedSubmit = { selector, text, timestamp: Date.now() };
        // ①対応: console.logでNode.js側に事前通知（ページ遷移後も情報が残る）
        console.log('__SUBMIT_CLICK__' + JSON.stringify({ selector, text }));
        // モーダル閉じなどナビゲーションが発生しない場合のフォールバック:
        // 1秒後にDOMの変化を通知して autoCollect を再トリガーする
        setTimeout(() => notify(), 1000);
        break;
      }
      el = el.parentElement;
    }
  }, true);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const el = mutation.target;
        const attr = mutation.attributeName;
        if (['disabled', 'readonly', 'style', 'class', 'hidden', 'aria-disabled', 'aria-expanded'].includes(attr || '')) {
          const isFormElement = el.matches('input, select, textarea') ||
                               el.querySelector('input, select, textarea');
          if (isFormElement || el.matches('fieldset, details, [role="group"], .collapse, .tab-pane, .accordion-body')) {
            notify();
          }
        }
      }
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            if (node.matches('input, select, textarea') || node.querySelector('input, select, textarea')) {
              notify();
            }
          }
        }
      }
    }
  });

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['disabled', 'readonly', 'style', 'class', 'hidden', 'aria-disabled', 'aria-expanded'],
    childList: true,
    subtree: true,
  });

  document.querySelectorAll('details').forEach(details => {
    details.addEventListener('toggle', notify);
  });

  console.log('[FieldWatcher] 監視を開始しました');
})()
