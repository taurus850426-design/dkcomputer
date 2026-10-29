/* Read-only order analysis; no storage or network writes. */
(function (root) {
  'use strict';
  const labels = { total: '總訂單', machine: '整機', repair: '維修', upgrade: '零件升級', other: '其他' };
  function typeOf(o) {
    const t = String(o.salesType || o.sales_type || '').trim();
    return t === '整機' ? 'machine' : (t === '維修' || t === '維修／服務') ? 'repair' : t === '零件升級' ? 'upgrade' : 'other';
  }
  function aggregate(orders, today, dateOf) {
    const end = String(today || '').slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(end)) throw new Error('Invalid reference month');
    const [year, month] = end.split('-').map(Number);
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(year, month - 12 + i, 1));
      return { month: d.toISOString().slice(0, 7), total: 0, machine: 0, repair: 0, upgrade: 0, other: 0 };
    });
    const index = new Map(months.map(m => [m.month, m]));
    (Array.isArray(orders) ? orders : []).forEach(o => {
      if (!o || ['refunded','lost','cancelled'].includes(o.status)) return;
      const date = String(dateOf(o) || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const parsed = new Date(date + 'T00:00:00Z');
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return;
      const bucket = index.get(date.slice(0, 7));
      if (bucket) { bucket.total++; bucket[typeOf(o)]++; }
    });
    return months;
  }
  const hosts = new WeakMap();
  function draw(host) {
    const state = hosts.get(host);
    const key = labels[host.dataset.series] ? host.dataset.series : 'total';
    const months = state.months;
    const name = labels[key];
    const section = host.closest('section');
    section.querySelectorAll('[data-order-series]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.orderSeries === key)));
    const max = Math.max(1, ...months.map(m => m[key]));
    const step = Math.max(1, Math.ceil(max / 4));
    const ceiling = step * 4;
    const points = months.map((m, i) => ({ x: 48 + i * 58, y: 194 - m[key] / ceiling * 156, m }));
    const grid = Array.from({ length: 5 }, (_, i) => '<line x1="48" x2="686" y1="' + (194-i*39) + '" y2="' + (194-i*39) + '" class="order-trend-grid"/><text x="36" y="' + (199-i*39) + '" text-anchor="end">' + i*step + '</text>').join('');
    const path = points.map((p, i) => (i ? 'L' : 'M') + p.x + ',' + p.y).join(' ');
    const detail = months.map(m => m.month + ' ' + m[key] + '筆').join('；');
    host.innerHTML = '<div class="order-trend-heading"><strong>近 12 個月・' + name + '</strong><span class="muted small">' + months[0].month + ' ～ ' + months[11].month + '（本月累計）</span></div>' +
      '<svg class="order-trend-svg" viewBox="0 0 720 240" aria-label="' + name + '每月訂單曲線" role="group"><title>' + name + '每月訂單曲線</title><desc>' + detail + '</desc>' + grid +
      '<path d="' + path + '" class="order-trend-line"/>' + points.map((p, i) => '<circle cx="' + p.x + '" cy="' + p.y + '" r="5" tabindex="0" data-month="' + i + '" aria-label="' + p.m.month + '，' + name + ' ' + p.m[key] + '筆"><title>' + p.m.month + '：' + p.m[key] + '筆</title></circle><text class="order-trend-month" data-index="' + i + '" x="' + p.x + '" y="226" text-anchor="middle">' + p.m.month.slice(5) + '月</text>').join('') + '</svg>' +
      '<output class="order-trend-detail" aria-live="polite">' + (months.every(m => !m[key]) ? '近 12 個月此分類尚無訂單。' : '滑鼠移到圓點，或點選圓點，查看當月筆數。') + '</output><p class="muted small">依訂單日期統計，排除退貨單；本月尚未結束。</p>';
    const show = e => {
      const dot = e.target.closest('[data-month]');
      if (!dot) return;
      const m = months[Number(dot.dataset.month)];
      host.querySelector('output').textContent = m.month + '・' + name + ' ' + m[key] + ' 筆';
    };
    host.querySelectorAll('circle[data-month]').forEach(dot => {
      dot.addEventListener('pointerenter', show);
      dot.addEventListener('focus', show);
      dot.addEventListener('click', show);
    });
  }
  function render(host, orders, options) {
    if (!host) return;
    hosts.set(host, { months: aggregate(orders, options.today, options.dateOf) });
    const section = host.closest('section');
    if (!section.dataset.trendBound) {
      section.dataset.trendBound = '1';
      section.addEventListener('click', e => {
        const button = e.target.closest('[data-order-series]');
        if (!button) return;
        host.dataset.series = button.dataset.orderSeries;
        draw(host);
      });
    }
    draw(host);
  }
  const api = { aggregate, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DKOrderTrend = api;
})(typeof window !== 'undefined' ? window : globalThis);
