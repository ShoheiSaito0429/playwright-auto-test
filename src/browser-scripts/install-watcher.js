/**
 * MutationObserver + 全クリック監視 注入スクリプト（B案: 全クリックキャプチャ）
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

  // セレクター構築
  const buildSelector = (el) => {
    if (!el) return '';
    if (el.id) return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).filter(Boolean);
      if (classes.length) return `${tag}.${classes.join('.')}`;
    }
    if (el.getAttribute('name')) return `${tag}[name="${el.getAttribute('name')}"]`;
    const text = el.textContent?.trim().substring(0, 20) || '';
    if (text) return `${tag}:has-text("${text}")`;
    return tag;
  };

  // クリック可能な要素か（ボタン・リンク系を広くキャプチャ）
  const isClickableElement = (el) => {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return true;
    if (tag === 'button') return true;
    if (tag === 'input' && ['submit', 'button', 'image'].includes(el.type)) return true;
    if (el.getAttribute('role') === 'button') return true;
    if (el.hasAttribute('onclick')) return true;
    return false;
  };

  // ラジオ・チェックボックス変更後に再収集（選択値を確実に取得するため）
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.type === 'radio' || el.type === 'checkbox' || el.tagName === 'SELECT') {
      notify();
    }
  }, true);

  // 全クリックイベントをキャプチャ → console.logでNode.js側に送信
  document.addEventListener('click', (e) => {
    let el = e.target;
    for (let i = 0; i < 5 && el; i++) {
      if (isClickableElement(el)) {
        const info = {
          ts: Date.now(),
          url: window.location.href,
          selector: buildSelector(el),
          text: (el.textContent || el.value || '').trim().substring(0, 50),
          tag: el.tagName.toLowerCase(),
        };
        console.log('__CLICK_EVENT__' + JSON.stringify(info));
        setTimeout(() => notify(), 500);
        break;
      }
      el = el.parentElement;
    }
  }, true);

  // MutationObserver（フォーム要素の変化を監視）
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

  console.log('[FieldWatcher] 監視を開始しました（全クリックキャプチャモード）');
})()
