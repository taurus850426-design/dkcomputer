(function () {
  'use strict';
  const el = id => document.getElementById(id);
  let order = null, generation = 0, busy = false;
  const message = text => { if(el('dkScanMessage')) el('dkScanMessage').textContent = text; };
  function render(data) {
    const list = el('dkScanResults'); if (!list) return;
    list.replaceChildren();
    for (const line of data.lines || []) {
      const li = document.createElement('li');
      li.textContent = line.name + '：' + line.serials.length + '/' + line.qty + ' 件已核對' + (line.exception ? '（無序號：' + line.exception + '）' : '') + (line.serials.length ? '｜' + line.serials.join('、') : '');
      list.append(li);
    }
    message((data.enabled ? '本單已啟用掃碼核對。' : '尚未啟用；確認裝入或登記無序號後啟用。') + (data.tested ? ' 測試已登記。' : ' 尚未登記測試。') + (data.ship_checked ? ' 出貨編號已核對；仍須儲存交付與結單。' : ' 尚未核對出貨編號。'));
  }
  async function run(action) {
    if (busy) return;
    if (!order?.id) return message('請先儲存訂單，再重新開啟做掃碼核對。');
    if (action !== 'read' && ['completed','shipped','cancelled','lost','refunded'].includes(order.status)) return message('此訂單已結束作業；請使用售後查詢。');
    const code = el('dkScanCode').value.trim(), line = el('dkScanLine').value, note = el('dkScanNote').value.trim();
    if (['bind','unbind','ship'].includes(action) && !code) return message('請先掃描或輸入編號。');
    if (['bind','unbind','waive'].includes(action) && !line) return message('請先選擇零件。');
    if (['test','waive'].includes(action) && note.length < 5) return message('請填至少 5 個字的檢測紀錄或無序號原因。');
    if (action !== 'read' && !window.confirm('確認登記這次' + ({bind:'組裝序號',unbind:'移除綁定',waive:'無序號說明',test:'測試通過',ship:'出貨編號核對'}[action] || '作業') + '？')) return;
    const token = generation, id = order.id;
    busy = true;
    try {
      const result = await window.dkScanOperation(action, id, code, line, note);
      if(token !== generation) return;
      if(!result?.ok) return message(result?.error || '連線失敗，請重新核對，勿重複操作。');
      render(result.data);
      if(action === 'bind' || action === 'unbind' || action === 'ship') el('dkScanCode').value = '';
    } catch (error) { if(token === generation) message('作業未確認成功：' + error.message); }
    finally { busy = false; }
  }
  function printLabels(codes) {
    if (!codes.length || codes.length > 100) return message('請先輸入序號，每次最多列印 100 張。');
    const labels = [];
    try {
      for (const code of codes) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        window.JsBarcode(svg, code, {format:'CODE128',width:2,height:55,margin:20,fontSize:14});
        labels.push(svg);
      }
    } catch (_) { return message('此編號無法產生條碼，請使用英文字母與數字。'); }
    const frame = document.createElement('iframe'); frame.title = 'DK 條碼貼紙'; frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px';
    document.body.append(frame);
    const doc = frame.contentDocument;
    doc.open(); doc.write('<!doctype html><html><head><title>DK 條碼貼紙</title><style>@page{margin:10mm}body{font-family:sans-serif}.label{break-inside:avoid;display:inline-block;border:1px dashed #999;margin:4mm;padding:2mm;text-align:center}svg{max-width:85mm;height:auto}</style></head><body></body></html>'); doc.close();
    for(const svg of labels) { const div=doc.createElement('div'); div.className='label'; const heading=doc.createElement('strong'); heading.textContent='DK Computer'; div.append(heading,doc.createElement('br'),doc.importNode(svg,true)); doc.body.append(div); }
    frame.contentWindow.onafterprint=()=>frame.remove();
    try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (_) { frame.remove(); message('列印視窗無法開啟，請檢查瀏覽器設定。'); }
  }
  el('dkScanPrintOrder')?.addEventListener('click', () => { if(!order?.id) return message('請先儲存訂單。'); printLabels([order.order_no]); });
  el('dkScanGenerateSerial')?.addEventListener('click', () => {
    const field=el('poReceiveSerials'); if(!field || field.disabled) return;
    const serial='DK-'+Array.from(window.crypto.getRandomValues(new Uint8Array(10)), b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
    field.value+=(field.value.trim()?'\n':'')+serial;
    field.dispatchEvent(new Event('input',{bubbles:true}));
  });
  el('dkScanPrintSerials')?.addEventListener('click', () => printLabels((el('poReceiveSerials')?.value || '').split(/[\r\n,，;；]+/).map(x=>x.trim()).filter(Boolean)));
  window.DKScanner = { open(o, lines) {
    order = o; generation++;
    el('dkScanCode').value = ''; el('dkScanNote').value = ''; el('dkScanResults').replaceChildren();
    el('dkScanLookup').value = ''; el('dkScanLookupResult').textContent = '';
    el('dkScanLine').replaceChildren();
    for(const line of lines || []) if(line.item_id) {
      const option = document.createElement('option'); option.value = line.line_key; option.textContent = line.name + ' × ' + line.qty; el('dkScanLine').append(option);
    }
    if(o?.id) run('read'); else message('請先儲存訂單，再重新開啟做掃碼核對。');
  } };
  for(const [suffix, action] of Object.entries({Bind:'bind', Unbind:'unbind', Refresh:'read', Waive:'waive', Test:'test', Ship:'ship'})) el('dkScan'+suffix)?.addEventListener('click', () => run(action));
  // A scanner's Enter suffix must never submit or confirm a write.
  ['dkScanCode','dkScanLookup'].forEach(id => el(id)?.addEventListener('keydown', event => { if(event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); } }));
  el('dkScanLookupBtn')?.addEventListener('click', async () => {
    const code = el('dkScanLookup').value.trim(), token = generation;
    if(!code) return;
    try {
      const r = await window.dkScanOperation('lookup', '', code);
      if(token !== generation) return;
      el('dkScanLookupResult').textContent = !r?.ok ? (r?.error || '查詢失敗') : JSON.stringify(r.data, null, 2);
    } catch(e) { if(token === generation) el('dkScanLookupResult').textContent = e.message; }
  });
})();
