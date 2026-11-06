/* Scan staging panel: read-only until a verified backoffice RPC is available. */
(function () {
  'use strict';
  function init() {
    const section = document.querySelector('#v2-items .inv-items-head');
    if (!section || !window.DKBarcodeScanner) return;
    const box = document.createElement('section');
    box.className = 'section-card admin-stack-gap';
    box.setAttribute('aria-label', '條碼掃描暫存');
    box.innerHTML = '<h3 class="h3 section-title">條碼掃描（暫存測試）</h3>' +
      '<p class="form-hint">目前僅暫存掃描結果，不會新增庫存、扣庫存或寫入資料庫。</p>' +
      '<div class="actions" style="display:flex;flex-wrap:wrap;gap:8px">' +
      '<input data-scan-code type="text" aria-label="條碼或原廠序號" placeholder="掃碼槍掃描／手動輸入條碼" autocomplete="off" />' +
      '<input data-scan-qty type="number" min="1" step="1" value="1" aria-label="加入數量" style="width:80px" />' +
      '<button data-scan-add class="btn btn-ghost" type="button">加入暫存</button>' +
      '<button data-scan-camera class="btn btn-ghost" type="button">開啟相機</button>' +
      '<button data-scan-clear class="btn btn-ghost" type="button">清空</button></div>' +
      '<video data-scan-video playsinline muted style="display:none;width:100%;max-width:400px;margin-top:10px"></video>' +
      '<p data-scan-message class="form-hint" role="status" aria-live="polite"></p>' +
      '<p data-scan-lookup class="form-hint" role="status" aria-live="polite"></p>' +
      '<div data-scan-results></div>';
    section.insertAdjacentElement('afterend', box);
    const code = box.querySelector('[data-scan-code]');
    const qty = box.querySelector('[data-scan-qty]');
    const message = box.querySelector('[data-scan-message]');
    const results = box.querySelector('[data-scan-results]');
    const camera = box.querySelector('[data-scan-camera]');
    const video = box.querySelector('[data-scan-video]');
    const staging = window.DKBarcodeScanner.createStaging();
    let stopCamera = null;
    let lookupSequence = 0;
    async function lookup(codeValue) {
      if (!window.DKBarcodeLookup) return;
      const current = ++lookupSequence;
      const result = await window.DKBarcodeLookup.findBySku(codeValue);
      if (current !== lookupSequence) return;
      const text = result.ok
        ? (result.item ? '庫存匹配：' + result.item.name + '（SKU ' + result.item.sku + '，現有 ' + result.item.qty_on_hand + '）' : '找不到相同 SKU，請人工確認；不會自動新增')
        : '查詢提醒：' + result.error;
      const label = box.querySelector('[data-scan-lookup]');
      if (label) label.textContent = text;
    }
    function render() {
      results.replaceChildren();
      for (const row of staging.list()) {
        const line = document.createElement('p');
        line.className = 'form-hint';
        line.textContent = row.barcode + ' × ' + row.qty;
        results.append(line);
      }
      message.textContent = '目前暫存 ' + staging.size() + ' 種條碼（未入庫）';
    }
    function add(value) {
      try {
        staging.add(value, qty.value);
        code.value = '';
        render();
        lookup(value);
      } catch (error) { message.textContent = error.message; }
    }
    window.DKBarcodeScanner.attachKeyboard(code, add);
    box.querySelector('[data-scan-add]').addEventListener('click', () => add(code.value));
    box.querySelector('[data-scan-clear]').addEventListener('click', () => { staging.clear(); render(); });
    camera.addEventListener('click', async () => {
      if (stopCamera) {
        stopCamera(); stopCamera = null; video.style.display = 'none';
        camera.textContent = '開啟相機'; return;
      }
      try {
        video.style.display = 'block';
        stopCamera = await window.DKBarcodeScanner.startCamera(video, add, {
          onError: () => { message.textContent = '相機辨識失敗，請改用掃碼槍或手動輸入'; }
        });
        camera.textContent = '關閉相機';
      } catch (error) {
        video.style.display = 'none';
        message.textContent = error.message;
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && stopCamera) {
        stopCamera(); stopCamera = null; video.style.display = 'none';
        camera.textContent = '開啟相機';
      }
    });
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
