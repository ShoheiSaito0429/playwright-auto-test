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
    }, 300);
  };

  // セレクター構築（一意性を優先した優先順位）
  const buildSelector = (el) => {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();

    // 1. id が最も確実
    if (el.id) return `#${el.id}`;

    // 2. href が固有な場合（javascript: リンクや固有パスは識別子として最強）
    const href = el.getAttribute('href') || '';
    if (href && href !== '#' && href !== 'javascript:void(0)' && href !== 'javascript:;') {
      return `${tag}[href="${href}"]`;
    }

    const text = el.textContent?.trim().replace(/\s+/g, ' ').substring(0, 30) || '';
    const classes = (typeof el.className === 'string')
      ? el.className.trim().split(/\s+/).filter(Boolean)
      : [];

    // 3. クラス + テキスト の組み合わせ（クラス単独より確実）
    if (classes.length && text) {
      return `${tag}.${classes.join('.')}:has-text("${text}")`;
    }

    // 4. テキストのみ（クラスがない場合）
    if (text) return `${tag}:has-text("${text}")`;

    // 5. クラスのみ（最終手段、同名クラスが複数ある可能性あり）
    if (classes.length) return `${tag}.${classes.join('.')}`;

    if (el.getAttribute('name')) return `${tag}[name="${el.getAttribute('name')}"]`;
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

  // ラジオ・チェックボックス・select変更後に再収集
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.type === 'radio' || el.type === 'checkbox' || el.tagName === 'SELECT') {
      notify();
    }
  }, true);

  // テキスト入力後に再収集（inputイベント：テキスト/数字/日付等）
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
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


  // ========================================
  // インタラクション記録（v2）
  // ========================================
  let _lastInteractionTs = Date.now();

  const _genId = () => Math.random().toString(36).slice(2, 10);

  const _getLabel = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const closest = el.closest('label, td, th, li');
    if (closest) return closest.textContent.trim().substring(0, 50);
    return el.textContent?.trim().substring(0, 50) || '';
  };

  const _sendInteraction = (payload) => {
    console.log('__INTERACTION__' + JSON.stringify(payload));
  };

  // フォーム変更イベント（radio / checkbox / select / text 入力）
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
    // ラジオは checked になったものだけ記録
    if (el.type === 'radio' && !el.checked) return;

    const now = Date.now();
    const msSincePrev = now - _lastInteractionTs;
    _lastInteractionTs = now;

    _sendInteraction({
      id: _genId(),
      pageUrl: window.location.href,
      action: 'change',
      selector: buildSelector(el),
      elementType: el.type || el.tagName.toLowerCase(),
      value: el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value,
      label: _getLabel(el),
      timestamp: now,
      msSincePrev,
    });
  }, true);

  // クリックイベント（リンク・ボタン）
  document.addEventListener('click', (e) => {
    let el = e.target;
    for (let i = 0; i < 5 && el; i++) {
      if (isClickableElement(el)) {
        const now = Date.now();
        const msSincePrev = now - _lastInteractionTs;
        _lastInteractionTs = now;

        _sendInteraction({
          id: _genId(),
          pageUrl: window.location.href,
          action: 'click',
          selector: buildSelector(el),
          elementType: el.tagName.toLowerCase(),
          value: el.getAttribute('href') || '',
          label: (el.textContent || '').trim().substring(0, 50),
          timestamp: now,
          msSincePrev,
        });
        break;
      }
      el = el.parentElement;
    }
  }, true);

  console.log('[FieldWatcher] 監視を開始しました（全クリックキャプチャモード）');
})()
