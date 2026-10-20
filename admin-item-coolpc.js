(function () {
  'use strict';
  const modal = document.getElementById('itemEditorModal');
  if (!modal) return;
  // Legacy item-name/category IDs also exist outside this editor.
  const field = id => modal.querySelector('#' + id);
  const button = field('itemCoolpcLookupBtn');
  const message = field('itemCoolpcLookupMsg');
  const results = field('itemCoolpcLookupResults');
  if (!button || !message || !results) return;
  let generation = 0, candidates = [], context = '';
  const key = () => JSON.stringify([field('itemName')?.value.trim(), field('itemCategory')?.value]);
  function show(text) { message.hidden = false; message.textContent = text; }
  function reset() {
    generation++;
    candidates = [];
    context = '';
    results.replaceChildren();
    results.hidden = true;
    message.hidden = true;
    message.textContent = '';
    button.disabled = false;
    button.textContent = '查原價屋';
  }
  function render(result) {
    candidates = Array.isArray(result.candidates) ? result.candidates : [];
    if (!candidates.length) { show('找不到相近商品，請調整名稱／規格，或手動填寫建議售價。'); return; }
    show('找到 ' + candidates.length + ' 筆候選，請核對完整型號後套用。原價屋為全新商品含稅價。');
    candidates.forEach((candidate, index) => {
      const card = document.createElement('div');
      card.className = 'section-card-soft';
      card.style.cssText = 'padding:12px;overflow-wrap:anywhere';
      const title = document.createElement('strong');
      title.textContent = String(candidate?.title || '未命名商品');
      const detail = document.createElement('p');
      detail.className = 'muted small';
      const price = Number(candidate?.price);
      const eligible = candidate?.eligible === true && Number.isSafeInteger(price) && price > 0;
      detail.textContent = '原價屋含稅價：' + (Number.isFinite(price) ? 'NT$' + price.toLocaleString('zh-TW') : '—') + (candidate?.reason ? '｜' + candidate.reason : '');
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'btn btn-ghost btn-sm';
      apply.disabled = !eligible;
      apply.textContent = eligible ? '套用建議售價 NT$' + price.toLocaleString('zh-TW') : '條件價，不可套用';
      apply.dataset.itemCoolpcIndex = String(index);
      card.append(title, detail, apply);
      results.append(card);
    });
    try {
      const url = new URL(result.sourceUrl);
      if (url.protocol === 'https:' && ['coolpc.com.tw', 'www.coolpc.com.tw'].includes(url.hostname)) {
        const source = document.createElement('a');
        source.href = url.href;
        source.target = '_blank';
        source.rel = 'noopener noreferrer';
        source.className = 'link';
        source.textContent = '來源：原價屋官方品類頁';
        results.append(source);
      }
    } catch (_) {}
    if (result.checkedAt) {
      const time = document.createElement('div');
      time.className = 'muted small';
      time.textContent = '查詢時間：' + String(result.checkedAt).replace('T', ' ').slice(0, 19);
      results.append(time);
    }
    results.hidden = false;
  }
  button.addEventListener('click', async () => {
    if (modal.hidden || button.disabled) return;
    reset();
    const query = field('itemName')?.value.trim() || '';
    const category = field('itemCategory')?.value || '';
    if (!query) return show('請先填寫名稱／規格，再查原價屋。');
    if (!category) return show('請先選擇品類，再查原價屋。');
    if (typeof window.DK?.lookupCoolpcPrices !== 'function') return show('查價功能尚未載入，請重新整理後再試。');
    const requestGeneration = generation;
    context = key();
    const requestContext = context;
    const current = () => generation === requestGeneration && !modal.hidden && key() === requestContext;
    button.disabled = true;
    button.textContent = '查詢中…';
    show('正在查詢原價屋官方含稅價…');
    try {
      const result = await window.DK.lookupCoolpcPrices({ query, category });
      if (!current()) return;
      if (!result?.ok) return show(String(result?.error || '原價屋查價失敗，請稍後再試。'));
      render(result);
    } catch (_) {
      if (current()) show('原價屋查價失敗，請稍後再試；原建議售價已保留。');
    } finally {
      if (generation === requestGeneration) { button.disabled = false; button.textContent = '查原價屋'; }
    }
  });
  results.addEventListener('click', event => {
    const apply = event.target.closest('[data-item-coolpc-index]');
    if (!apply || apply.disabled || modal.hidden || context !== key()) return;
    const candidate = candidates[Number(apply.dataset.itemCoolpcIndex)];
    const price = Number(candidate?.price);
    if (candidate?.eligible !== true || !Number.isSafeInteger(price) || price <= 0) return;
    const input = field('itemPriceList');
    input.value = String(price);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    show('已套用建議售價 NT$' + price.toLocaleString('zh-TW') + '；按「儲存」後才會更新品項。');
  });
  field('itemName')?.addEventListener('input', reset);
  field('itemCategory')?.addEventListener('change', reset);
  new MutationObserver(reset).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
})();
