/**
 * ブラウザ内で実行されるフィールド収集スクリプト
 * TypeScriptを経由しない純粋なJSファイル（esbuildの__name注入を回避）
 */
(() => {
  const fields = [];

  // ========== ヘルパー関数 ==========

  const getLabel = (el) => {
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.textContent?.trim() || '';
    }
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach(c => c.remove());
      return clone.textContent?.trim() || '';
    }
    const prev = el.previousElementSibling;
    if (prev && ['LABEL', 'SPAN', 'DIV', 'TH', 'DT', 'P'].includes(prev.tagName)) {
      return prev.textContent?.trim() || '';
    }
    const td = el.closest('td');
    if (td) {
      const tr = td.closest('tr');
      if (tr) {
        const th = tr.querySelector('th');
        if (th) return th.textContent?.trim() || '';
      }
    }
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
  };

  const buildSelector = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
    if (el.getAttribute('name')) {
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute('name');
      const type = el.getAttribute('type');
      if (type === 'radio') return `${tag}[name="${name}"][value="${el.value}"]`;
      return `${tag}[name="${name}"]`;
    }
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.querySelectorAll(`:scope > ${tag}`));
      const index = siblings.indexOf(el) + 1;
      if (parent.id) return `#${CSS.escape(parent.id)} > ${tag}:nth-of-type(${index})`;
    }
    return tag;
  };

  const getVisibilityInfo = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none') return { isVisible: false, isHiddenByCSS: true, hiddenReason: 'display:none' };
    if (style.visibility === 'hidden') return { isVisible: false, isHiddenByCSS: true, hiddenReason: 'visibility:hidden' };
    if (style.opacity === '0') return { isVisible: false, isHiddenByCSS: true, hiddenReason: 'opacity:0' };
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && el.getAttribute('type') !== 'hidden') {
      return { isVisible: false, isHiddenByCSS: true, hiddenReason: 'size:0' };
    }
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const ps = getComputedStyle(parent);
      if (ps.display === 'none') return { isVisible: false, isHiddenByCSS: true, hiddenReason: `parent(${parent.tagName.toLowerCase()})display:none` };
      if (ps.visibility === 'hidden') return { isVisible: false, isHiddenByCSS: true, hiddenReason: `parent(${parent.tagName.toLowerCase()})visibility:hidden` };
      parent = parent.parentElement;
    }
    if (el.offsetParent === null && style.position !== 'fixed') {
      return { isVisible: false, isHiddenByCSS: true, hiddenReason: 'offsetParent:null' };
    }
    return { isVisible: true, isHiddenByCSS: false, hiddenReason: '' };
  };

  const getFieldState = (el) => {
    const vis = getVisibilityInfo(el);
    const isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
    const isReadonly = el.readOnly || el.getAttribute('aria-readonly') === 'true';
    const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
    const inCollapsed = !!el.closest('details:not([open])') ||
                        !!el.closest('[aria-expanded="false"]') ||
                        !!el.closest('.collapse:not(.show)');
    const parentFieldset = el.closest('fieldset');
    const fieldsetDisabled = parentFieldset ? parentFieldset.disabled : false;

    let state = 'active';
    if (!vis.isVisible || vis.isHiddenByCSS) state = 'hidden';
    else if (inCollapsed) state = 'collapsed';
    else if (isDisabled || fieldsetDisabled) state = 'disabled';
    else if (isReadonly) state = 'readonly';

    let dependsOn = '';
    if (isDisabled || fieldsetDisabled || !vis.isVisible) {
      const form = el.closest('form') || el.closest('fieldset') || el.closest('[role="group"]') || el.closest('div');
      if (form) {
        const triggerCandidates = form.querySelectorAll('input[type="radio"], input[type="checkbox"], select');
        for (const trigger of triggerCandidates) {
          if (trigger === el) continue;
          const handlers = (trigger.getAttribute('onchange') || '') +
                           (trigger.getAttribute('onclick') || '') +
                           (trigger.getAttribute('data-target') || '') +
                           (trigger.getAttribute('data-toggle') || '');
          if (el.id && handlers.includes(el.id)) { dependsOn = buildSelector(trigger); break; }
          if (el.name && handlers.includes(el.name)) { dependsOn = buildSelector(trigger); break; }
        }
      }
    }
    return { state, isDisabled: isDisabled || fieldsetDisabled, isReadonly, isVisible: vis.isVisible, isHiddenByCSS: vis.isHiddenByCSS, ariaDisabled, dependsOn };
  };

  // ========== フィールド収集 ==========

  const textTypes = ['text', 'email', 'password', 'number', 'date', 'tel', 'url', 'search', 'datetime-local', 'time', 'month', 'week'];
  const specialTypes = ['range', 'color'];  // 特殊入力タイプ（そのまま保持）
  document.querySelectorAll('input').forEach(el => {
    const type = (el.type || 'text').toLowerCase();
    if (['hidden','submit','button','reset','image','radio','checkbox','file'].includes(type)) return;
    const stateInfo = getFieldState(el);
    // range/colorはそのまま保持、textTypesはそのまま、それ以外はtext
    const resolvedType = specialTypes.includes(type) ? type : (textTypes.includes(type) ? type : 'text');
    fields.push({ selector: buildSelector(el), type: resolvedType, label: getLabel(el), name: el.name, elementId: el.id, value: el.value, ...stateInfo });
  });

  document.querySelectorAll('textarea').forEach(el => {
    const stateInfo = getFieldState(el);
    fields.push({ selector: buildSelector(el), type: 'textarea', label: getLabel(el), name: el.name, elementId: el.id, value: el.value, ...stateInfo });
  });

  const radioGroups = new Map();
  document.querySelectorAll('input[type="radio"]').forEach(el => {
    const group = el.name || buildSelector(el);
    if (!radioGroups.has(group)) radioGroups.set(group, []);
    radioGroups.get(group).push(el);
  });
  radioGroups.forEach((elements, groupName) => {
    const checked = elements.find(e => e.checked);
    const stateInfo = getFieldState(elements[0]);
    const hasActive = elements.some(e => { const vis = getVisibilityInfo(e); return !e.disabled && vis.isVisible; });
    if (hasActive && stateInfo.state === 'disabled') { stateInfo.state = 'active'; stateInfo.isDisabled = false; }
    fields.push({
      selector: `input[type="radio"][name="${groupName}"]`, type: 'radio',
      label: getLabel(elements[0]), name: groupName, elementId: elements[0].id,
      value: checked?.value || '', radioValue: checked?.value || '', checked: !!checked,
      options: elements.map(e => ({ value: e.value, text: getLabel(e) || e.value })),
      ...stateInfo,
    });
  });

  document.querySelectorAll('select').forEach(el => {
    const selectedOption = el.options[el.selectedIndex];
    const stateInfo = getFieldState(el);
    fields.push({
      selector: buildSelector(el), type: 'select', label: getLabel(el),
      name: el.name, elementId: el.id, value: el.value,
      selectedText: selectedOption?.text || '',
      options: Array.from(el.options).map(o => ({ value: o.value, text: o.text })),
      ...stateInfo,
    });
  });

  document.querySelectorAll('input[type="checkbox"]').forEach(el => {
    const stateInfo = getFieldState(el);
    fields.push({ selector: buildSelector(el), type: 'checkbox', label: getLabel(el), name: el.name, elementId: el.id, value: el.checked ? 'true' : 'false', checked: el.checked, ...stateInfo });
  });

  document.querySelectorAll('input[type="file"]').forEach(el => {
    const stateInfo = getFieldState(el);
    fields.push({ selector: buildSelector(el), type: 'file', label: getLabel(el), name: el.name, elementId: el.id, value: '', filePath: '', ...stateInfo });
  });

  return fields;
})()
