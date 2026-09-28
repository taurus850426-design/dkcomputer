const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const collector = read('supabase/functions/used-market-collector/index.ts').replace(/^import .*\n/, '');
const context = { Deno: { serve() {} }, Response, URLSearchParams, AbortSignal };
vm.createContext(context);
vm.runInContext(stripTypeScriptTypes(collector), context);

test('candidate filtering separates related models and memory variants', () => {
  const check = (title, model, variant = '') => context.classify(title, 5000, 100, 20000, model, variant).accepted;
  assert.equal(check('二手 RTX 3060 12GB 顯示卡', 'RTX 3060', '12GB'), true);
  assert.equal(check('二手 RTX 3060 Ti 8GB 顯示卡', 'RTX 3060', '12GB'), false);
  assert.equal(check('二手 RTX 3060 8GB 顯示卡', 'RTX 3060', '12GB'), false);
  assert.equal(check('AMD Ryzen 5 5600X 二手 CPU', 'Ryzen 5 5600'), false);
  assert.equal(check('Intel i7-10700F 二手 CPU', 'i7-10700'), false);
  assert.equal(check('全新 RTX 3060 12GB', 'RTX 3060', '12GB'), false);
  assert.equal(check('故障 RTX 3060 12GB', 'RTX 3060', '12GB'), false);
  assert.equal(context.classify('RTX 3060', 1, 100, 20000, 'RTX 3060').accepted, false);
});

test('observation attributes escape quotes and reject script URLs', () => {
  const source = read('used-market-auto-admin.js');
  const helpers = source.slice(source.indexOf('  const esc'), source.indexOf('  function message'));
  const ctx = { URL, document: { createElement: () => ({ set textContent(v) { this.innerHTML = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }) } };
  vm.createContext(ctx);
  vm.runInContext(helpers + ';globalThis.helpers = {esc, safeUrl};', ctx);
  assert.equal(ctx.helpers.esc('" onmouseover="evil'), '&quot; onmouseover=&quot;evil');
  assert.equal(ctx.helpers.safeUrl('javascript:alert(1)'), '');
  assert.equal(ctx.helpers.safeUrl('https://example.com/'), 'https://example.com/');
});

test('completing an existing order writes delivery first and stops on failure', async () => {
  const source = read('admin3.js');
  const start = source.indexOf('        let res;\n        if (editingV2OrderId)');
  assert.ok(start > 0);
  const finish = source.indexOf('        } else {', start);
  const code = source.slice(start, finish) + '\n} return res;';
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('DK', 'payload', 'previousOrder', 'editingV2OrderId', 'v2Show', 'orderMsg', code);
  for (const success of [true, false]) {
    const calls = [];
    const dk = {
      setOrderOperations: async () => { calls.push('delivery'); return { ok: success, error: 'failed' }; },
      updateOrder: async () => { calls.push('complete'); return { ok: true }; },
    };
    await run(dk, { status: 'completed', delivery_status: 'delivered' }, { delivery_status: 'pending' }, 'order-1', () => {}, {});
    assert.deepEqual(calls, success ? ['delivery', 'complete'] : ['delivery']);
  }
});
