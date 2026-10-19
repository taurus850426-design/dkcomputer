/* Read existing funding lots only; null owner must never assign ownership. */
(function (root) {
  'use strict';
  const generations = new WeakMap();
  function describe(result) {
    const data = result && result.ok && result.data;
    if (!data || !['hala', 'boss', 'mixed'].includes(data.owner)) return { label: '讀取失敗', title: '出資資料暫時無法讀取，請稍後重新整理；未變更任何紀錄。' };
    const boss = Number(data.boss_qty), hala = Number(data.hala_qty);
    if (!Number.isFinite(boss) || !Number.isFinite(hala)) return { label: '讀取失敗', title: '出資資料不完整，未推定出資方。' };
    if (boss + hala <= 0) return { label: '—', title: '目前沒有剩餘庫存的出資紀錄。' };
    return { label: data.owner === 'mixed' ? 'HALA／BOSS' : data.owner.toUpperCase(), title: '剩餘出資庫存：HALA ' + hala + ' 件、BOSS ' + boss + ' 件' };
  }
  async function populate(tbody, dk, canRead) {
    if (!tbody) return;
    const generation = (generations.get(tbody) || 0) + 1;
    generations.set(tbody, generation);
    const cells = Array.from(tbody.querySelectorAll('[data-funding-item]'));
    const current = cell => generations.get(tbody) === generation && cell.isConnected;
    if (!canRead()) { cells.forEach(cell => { cell.hidden = true; cell.textContent = ''; }); return; }
    let next = 0;
    async function worker() {
      while (next < cells.length) {
        const cell = cells[next++];
        if (!current(cell) || !canRead()) return;
        let result;
        try { result = await dk.stage7InventoryItemFunding(cell.dataset.fundingItem, null); }
        catch (_) { result = null; }
        if (!current(cell)) continue;
        if (!canRead()) { cell.hidden = true; cell.textContent = ''; continue; }
        const info = describe(result);
        cell.textContent = info.label;
        cell.title = info.title;
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, cells.length) }, worker));
  }
  const api = { describe, populate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DKInventoryFunding = api;
})(typeof window !== 'undefined' ? window : globalThis);
