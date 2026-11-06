/* Read-only authenticated lookup against the existing inventory_items table. */
(function (root) {
  'use strict';
  async function findBySku(code, dependencies = {}) {
    const dk = dependencies.dk || root.DK;
    const fetcher = dependencies.fetch || root.fetch?.bind(root);
    const value = String(code == null ? '' : code).trim();
    if (!value) return { ok: false, error: '請輸入條碼或 SKU' };
    if (!dk?.getSupabaseRestAuthHeaders || !dk?.getSupabaseProjectUrl || !fetcher)
      return { ok: false, error: '後台資料連線尚未就緒' };
    const auth = await dk.getSupabaseRestAuthHeaders({ requireUser: true });
    if (!auth?.ok) return { ok: false, error: auth?.error || '請先登入後台' };
    const url = dk.getSupabaseProjectUrl().replace(/\/$/, '') +
      '/rest/v1/inventory_items?select=id,sku,name,brand,model,qty_on_hand&sku=eq.' +
      encodeURIComponent(value) + '&limit=2';
    try {
      const response = await fetcher(url, { headers: auth.headers, cache: 'no-store' });
      if (!response.ok) return { ok: false, error: '查詢失敗（HTTP ' + response.status + '）' };
      const rows = await response.json();
      if (!Array.isArray(rows)) return { ok: false, error: '查詢資料格式錯誤' };
      if (rows.length > 1) return { ok: false, error: 'SKU 不唯一，請人工確認' };
      return { ok: true, item: rows[0] || null };
    } catch (_) { return { ok: false, error: '無法連線庫存資料庫' }; }
  }
  const api = { findBySku };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DKBarcodeLookup = api;
})(typeof window !== 'undefined' ? window : globalThis);
