(function () {
  'use strict';
  let activeFrame = null;
  window.DKQuotePrint = function (canvas, filename) {
    if (activeFrame?.isConnected) return Promise.reject(new Error('列印視窗已開啟，請先完成或取消本次列印'));
    let source;
    try {
      if (!canvas || canvas.width < 1 || canvas.height < 1) throw new Error('報價單圖片尚未準備完成');
      source = canvas.toDataURL('image/png');
      if (!source.startsWith('data:image/png')) throw new Error('報價單圖片產生失敗');
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.title = '報價單列印';
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0';
      activeFrame = frame;
      let loadTimer, cleanupTimer, settled = false;
      function cleanup() {
        clearTimeout(loadTimer);
        clearTimeout(cleanupTimer);
        frame.remove();
        if (activeFrame === frame) activeFrame = null;
      }
      function fail(error) {
        cleanup();
        if (!settled) { settled = true; reject(error); }
      }
      frame.onload = async function () {
        frame.onload = null;
        try {
          const doc = frame.contentDocument;
          const target = frame.contentWindow;
          if (!doc || !target) throw new Error('無法開啟列印頁面');
          doc.title = String(filename || 'DK-報價單').replace(/\.png$/i, '');
          const style = doc.createElement('style');
          style.textContent = '@page{size:A4;margin:8mm}html,body{margin:0;padding:0;background:#fff}img{display:block;width:100%;height:auto;max-height:281mm;object-fit:contain;break-inside:avoid}';
          doc.head.append(style);
          const img = doc.createElement('img');
          img.alt = '報價單';
          const loaded = typeof img.decode === 'function' ? null : new Promise((yes, no) => { img.onload = yes; img.onerror = () => no(new Error('報價單圖片載入失敗')); });
          img.src = source;
          doc.body.append(img);
          if (typeof img.decode === 'function') await img.decode();
          else await loaded;
          if (!frame.isConnected) return;
          clearTimeout(loadTimer);
          target.addEventListener('afterprint', cleanup, { once: true });
          // Some mobile browsers do not emit afterprint; retain the page long enough to print.
          cleanupTimer = setTimeout(cleanup, 300000);
          target.focus();
          target.print();
          settled = true;
          resolve();
        } catch (error) { fail(error); }
      };
      frame.src = 'about:blank';
      loadTimer = setTimeout(() => fail(new Error('列印頁面準備逾時，請重試')), 20000);
      document.body.append(frame);
    });
  };
})();
