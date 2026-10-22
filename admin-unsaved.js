/* Protect form drafts without writing anything merely because an editor opened. */
(function () {
  'use strict';
  const forms = new Map();
  let dialog = null, pending = null, saving = false, replay = null;
  const active = form => form.root && !form.root.closest('[hidden]');
  const dirty = form => active(form) && form.baseline !== null &&
    (form.baseline !== JSON.stringify(form.read()) || !!form.pending?.());
  function close() {
    if (saving) return;
    const target = pending?.target;
    dialog?.remove(); dialog = null; pending = null; target?.focus();
  }
  function resume() {
    const target = pending.target; close(); replay = target;
    try { target.click(); } finally { replay = null; }
  }
  function ask(form, target) {
    if (pending) return;
    pending = { form, target };
    dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'unsavedTitle');
    dialog.style.cssText = 'width:min(480px,calc(100% - 32px));box-sizing:border-box;border:1px solid #ccd4d0;border-radius:16px;padding:24px;background:#fff;color:#263b40;box-shadow:0 20px 80px #0004';
    dialog.innerHTML = '<h2 id="unsavedTitle" style="margin:0 0 12px;font-size:22px"></h2><p>有尚未儲存的資料，離開前是否儲存？</p><p data-error role="alert" style="color:#a62947;white-space:pre-wrap"></p><div style="display:flex;flex-wrap:wrap;gap:10px"><button type="button" data-choice="save">儲存後離開</button><button type="button" data-choice="discard">不儲存離開</button><button type="button" data-choice="stay">繼續編輯</button></div>';
    dialog.querySelector('h2').textContent = form.label + '尚未儲存';
    for (const button of dialog.querySelectorAll('button')) button.style.cssText = 'padding:10px 14px;border-radius:8px;border:1px solid #bbc9c4;background:#f2f5f1;color:inherit;font:inherit;cursor:pointer';
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const buttons = [...dialog.querySelectorAll('button:not(:disabled)')];
      if (!buttons.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
    });
    dialog.addEventListener('click', async event => {
      const choice = event.target.closest('[data-choice]')?.dataset.choice;
      if (!choice || saving) return;
      if (choice === 'stay') return close();
      if (choice === 'discard') { form.discard(); resume(); return; }
      saving = true; dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
      const error = dialog.querySelector('[data-error]'); error.textContent = '正在儲存，請稍候…';
      let ok = false;
      try { ok = await form.save(); } catch (_) { /* Keep draft and destination. */ }
      saving = false;
      if (ok && !dirty(form)) { form.discard(); resume(); return; }
      error.textContent = '尚未完成儲存，資料仍保留。請按「繼續編輯」，查看表單提示並補齊資料或重新核對同步結果。';
      dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
    });
    document.body.append(dialog);
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    dialog.querySelector('[data-choice="stay"]').focus();
    if (form.busy?.()) {
      dialog.querySelector('[data-error]').textContent = '作業仍在處理中，請先繼續留在此頁，待結果確認後再離開。';
      dialog.querySelector('[data-choice="save"]').disabled = true;
      dialog.querySelector('[data-choice="discard"]').disabled = true;
    }
  }
  function leaves(name, target) {
    if (target.id === 'logoutBtn') return true;
    if (name === 'order' && target.matches('#orderCancel,#btnNewOrder,.btn-edit-order')) return true;
    if (name === 'purchase' && target.matches('#poBackToListBtn,#poNewBtn,[data-po-act="edit"]')) return true;
    const v2 = target.getAttribute('data-v2'), tab = target.getAttribute('data-tab');
    if (v2) return name === 'order' ? v2 !== 'orders' : true;
    if (tab) return name === 'order' ? tab !== 'inv' : tab !== 'purchase';
    if (target.matches('a[href]') && target.target !== '_blank' && !target.hasAttribute('download')) {
      const url = new URL(target.href, location.href);
      return url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search;
    }
    return false;
  }
  document.addEventListener('click', event => {
    const target = event.target.closest?.('button,a,[data-tab],[data-v2]');
    if (!target || target === replay || dialog?.contains(target)) return;
    for (const [name, form] of forms) {
      if (!leaves(name, target) || (!dirty(form) && !(active(form) && form.busy?.()))) continue;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!pending) ask(form, target);
      return;
    }
  }, true);
  window.addEventListener('beforeunload', event => {
    if (saving || [...forms.values()].some(form => dirty(form) || (active(form) && form.busy?.()))) {
      event.preventDefault(); event.returnValue = '';
    }
  });
  window.DKUnsaved = {
    register(name, options) {
      const form = { ...options, baseline: null }; forms.set(name, form);
      return {
        clean(snapshot) { form.baseline = snapshot === undefined ? JSON.stringify(form.read()) : snapshot; },
        reset() { form.baseline = null; },
        dirty() { return dirty(form); },
        snapshot() { return JSON.stringify(form.read()); }
      };
    }
  };
})();
