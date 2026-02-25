/**
 * MutationObserver 注入スクリプト
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
