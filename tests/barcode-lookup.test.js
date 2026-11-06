const test = require('node:test');
const assert = require('node:assert/strict');
const { findBySku } = require('../barcode-lookup.js');
function deps(fetch) {
  return { dk: {
    getSupabaseProjectUrl: () => 'https://example.supabase.co',
    getSupabaseRestAuthHeaders: async () => ({ ok: true, headers: { Authorization: 'Bearer test-token' } })
  }, fetch };
}
test('exact SKU match uses authenticated read-only GET', async () => {
  let seen;
  const result = await findBySku(' ABC 123 ', deps(async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => [{ id: 'I-1', sku: 'ABC 123', name: 'Test' }] };
  }));
  assert.equal(result.item.id, 'I-1');
  assert.match(seen.url, /sku=eq.ABC%20123/);
  assert.equal(seen.opts.headers.Authorization, 'Bearer test-token');
  assert.equal(seen.opts.cache, 'no-store');
  assert.equal(seen.opts.method, undefined);
});
test('not found does not invent product', async () => {
  const result = await findBySku('missing', deps(async () => ({ ok: true, json: async () => [] })));
  assert.deepEqual(result, { ok: true, item: null });
});
test('unauthenticated query never fetches', async () => {
  const result = await findBySku('ABC', {
    dk: { getSupabaseProjectUrl: () => 'https://example.supabase.co', getSupabaseRestAuthHeaders: async () => ({ ok: false, error: '登入失效' }) },
    fetch: () => { throw new Error('must not fetch'); }
  });
  assert.deepEqual(result, { ok: false, error: '登入失效' });
});
test('duplicate SKU is not silently selected', async () => {
  const result = await findBySku('ABC', deps(async () => ({ ok: true, json: async () => [{}, {}] })));
  assert.equal(result.ok, false);
});
