/* DK scanner input adapter. No inventory writes: scan results remain staged. */
(function (root) {
  'use strict';
  const FORMATS = ['ean_13','upc_a','code_128','code_39'];
  function normalize(value) { return String(value == null ? '' : value).trim(); }
  function createStaging() {
    const rows = new Map();
    return {
      add(value, count = 1) {
        const code = normalize(value);
        if (!code) throw new Error('條碼不可空白');
        const qty = Number(count);
        if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('數量必須是正整數');
        rows.set(code, (rows.get(code) || 0) + qty);
        return rows.get(code);
      },
      set(value, count) {
        const code = normalize(value), qty = Number(count);
        if (!code || !Number.isSafeInteger(qty) || qty < 0) throw new Error('無效條碼或數量');
        if (qty === 0) rows.delete(code); else rows.set(code, qty);
      },
      list() { return Array.from(rows, ([barcode, qty]) => ({ barcode, qty })); },
      clear() { rows.clear(); },
      size() { return rows.size; }
    };
  }
  function attachKeyboard(input, onScan) {
    if (!input || typeof input.addEventListener !== 'function') throw new Error('需要輸入欄位');
    function handle(event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const code = normalize(input.value);
      if (!code) return;
      input.value = '';
      onScan(code);
    }
    input.addEventListener('keydown', handle);
    return () => input.removeEventListener('keydown', handle);
  }
  async function startCamera(video, onScan, options = {}) {
    if (!root.isSecureContext) throw new Error('相機需要 HTTPS 安全連線');
    if (!root.navigator?.mediaDevices?.getUserMedia) throw new Error('瀏覽器不支援相機');
    if (!root.BarcodeDetector) throw new Error('此瀏覽器不支援 BarcodeDetector，請使用掃碼槍或手動輸入');
    const supported = await root.BarcodeDetector.getSupportedFormats();
    const formats = FORMATS.filter(format => supported.includes(format));
    if (!formats.length) throw new Error('瀏覽器不支援所需條碼格式');
    const detector = new root.BarcodeDetector({ formats });
    const stream = await root.navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    let stopped = false, raf = null, busy = false, lastCode = '', lastAt = 0;
    video.srcObject = stream;
    try { await video.play(); } catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
    const cooldown = Number(options.cooldownMs) > 0 ? Number(options.cooldownMs) : 900;
    async function tick() {
      if (stopped) return;
      if (!busy && video.readyState >= 2) {
        busy = true;
        try {
          const found = await detector.detect(video);
          const code = normalize(found[0]?.rawValue);
          const now = Date.now();
          if (code && (code !== lastCode || now - lastAt >= cooldown)) {
            lastCode = code; lastAt = now; onScan(code);
          }
        } catch (error) { options.onError?.(error); }
        finally { busy = false; }
      }
      if (!stopped) raf = root.requestAnimationFrame(tick);
    }
    raf = root.requestAnimationFrame(tick);
    return function stop() {
      stopped = true;
      if (raf != null) root.cancelAnimationFrame(raf);
      stream.getTracks().forEach(track => track.stop());
      video.pause(); video.srcObject = null;
    };
  }
  const api = { createStaging, attachKeyboard, startCamera, supportedFormats: FORMATS.slice() };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DKBarcodeScanner = api;
})(typeof window !== 'undefined' ? window : globalThis);
