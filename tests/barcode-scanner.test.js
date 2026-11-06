/* Run: node --test tests/barcode-scanner.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStaging, attachKeyboard, supportedFormats } = require('../barcode-scanner.js');

test('repeat scan increments staged quantity', () => {
  const batch = createStaging();
  assert.equal(batch.add(' 4711234567890 '), 1);
  assert.equal(batch.add('4711234567890'), 2);
  assert.deepEqual(batch.list(), [{ barcode: '4711234567890', qty: 2 }]);
});
test('manual quantity, removal and reset', () => {
  const batch = createStaging();
  batch.add('DK-001', 3);
  batch.set('DK-001', 8);
  assert.equal(batch.list()[0].qty, 8);
  batch.set('DK-001', 0);
  assert.equal(batch.size(), 0);
  batch.add('A');
  batch.clear();
  assert.deepEqual(batch.list(), []);
});
test('invalid input does not alter batch', () => {
  const batch = createStaging();
  assert.throws(() => batch.add(' '));
  assert.throws(() => batch.add('A', -1));
  assert.throws(() => batch.add('A', 1.5));
  assert.throws(() => batch.set('A', -1));
  assert.deepEqual(batch.list(), []);
});
test('keyboard scanner handles Enter and detaches', () => {
  let handler, detached = false, scanned = '';
  const input = {
    value: ' SN123 ',
    addEventListener(type, cb) { assert.equal(type, 'keydown'); handler = cb; },
    removeEventListener(type, cb) { detached = type === 'keydown' && cb === handler; }
  };
  const stop = attachKeyboard(input, code => { scanned = code; });
  let prevented = false;
  handler({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(scanned, 'SN123');
  assert.equal(input.value, '');
  assert.equal(prevented, true);
  stop();
  assert.equal(detached, true);
});
test('barcode format set', () => {
  assert.deepEqual(supportedFormats, ['ean_13', 'upc_a', 'code_128', 'code_39']);
});
