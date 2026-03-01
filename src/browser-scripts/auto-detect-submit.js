/**
 * 送信ボタン自動検出スクリプト（esbuildの__name注入を回避するため外部JSファイル化）
 */
(() => {
  var patterns = [
    'button[type="submit"]:not([disabled])',
    'input[type="submit"]:not([disabled])',
    'input[type="image"]',
    'a[href^="javascript:"]',
    'a.nextBtn','a.nextBtn2',
    '[role="button"]','div[onclick]','span[onclick]',
    'button.btn-primary:not([disabled])','button.submit:not([disabled])',
    'a.btn-primary','a.btn-submit','.btn-start','.submit-btn',
  ];
  var textPatterns = ['次へ','進む','確認','送信','完了','登録','保存','スタート','診断','開始','申込','見積','next','submit','confirm','start'];
  var excludeTexts = ['閉じる','戻る','キャンセル','close','back','cancel','×','✕'];
  var excludeClasses = ['js-close','js-close-all','mfp-close','s-close','c-back'];

  function isExcluded(el) {
    var text = (el.textContent || '').trim().toLowerCase();
    var cls = el.className || '';
    if (excludeTexts.some(function(t){ return text.includes(t.toLowerCase()); })) return true;
    if (excludeClasses.some(function(c){ return cls.includes(c); })) return true;
    var href = el.getAttribute('href') || '';
    if (href.toLowerCase().includes('close') || href.toLowerCase().includes('magnificpopup')) return true;
    return false;
  }
  function buildSel(el) {
    if (el.id) return '#' + el.id;
    var href = el.getAttribute('href') || '';
    if (href && href !== '#' && !href.startsWith('javascript:void')) return el.tagName.toLowerCase()+'[href="'+href+'"]';
    var cls = el.className && typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    if (cls) return el.tagName.toLowerCase()+'.'+cls;
    var nm = el.getAttribute('name');
    if (nm) return '[name="'+nm+'"]';
    return el.tagName.toLowerCase();
  }

  for (var i=0;i<patterns.length;i++){
    var els = Array.from(document.querySelectorAll(patterns[i]));
    for (var j=0;j<els.length;j++){
      var el=els[j], st=window.getComputedStyle(el);
      if(st.display==='none'||st.visibility==='hidden') continue;
      if(isExcluded(el)) continue;
      return buildSel(el);
    }
  }
  var all=Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],a,[role="button"]'));
  for(var k=0;k<all.length;k++){
    var btn=all[k], bs=window.getComputedStyle(btn);
    if(bs.display==='none'||bs.visibility==='hidden') continue;
    if(isExcluded(btn)) continue;
    var combined=((btn.textContent||'').trim()+' '+(btn.value||'')).toLowerCase();
    for(var m=0;m<textPatterns.length;m++){
      if(combined.includes(textPatterns[m].toLowerCase())) return buildSel(btn);
    }
  }
  return null;
})()
