const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup() {
  class Element {
    constructor(id = '', parent = null) {
      this.id = id; this.parentElement = parent; this.nodeType = 1;
      this.dataset = {}; this.hidden = false; this.isConnected = true; this.textContent = '';
      this.children = []; this.events = {}; this.classes = new Set();
      this.classList = { add: (v) => this.classes.add(v), remove: (v) => this.classes.delete(v), contains: (v) => this.classes.has(v) };
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector === '[hidden]' ? node.hidden : node.id.endsWith('Msg')) return node;
      }
      return null;
    }
    setAttribute() {}
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(event, fn) { this.events[event] = fn; }
  }
  const toast = new Element('adminToast'); toast.hidden = true;
  const page = new Element('page');
  const source = new Element('pageMsg', page);
  const other = new Element('otherMsg');
  const timers = new Map(); const microtasks = []; const frames = [];
  let observer; let timerId = 0;
  const context = { window: {}, document: { body: new Element(), getElementById: () => toast, createElement: () => new Element() },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => frames.push(fn), queueMicrotask: (fn) => microtasks.push(fn), Date };
  const sourceCode = fs.readFileSync(path.join(__dirname, '../admin3.js'), 'utf8');
  vm.runInNewContext(sourceCode.slice(sourceCode.indexOf('  function inferFeedbackType'), sourceCode.indexOf('  function showCenterToast')) + '\ninitAdminFeedback();', context);
  const mutate = (node) => { observer([{ target: node }]); while (microtasks.length) microtasks.shift()(); };
  const flushFrames = () => { while (frames.length) frames.shift()(); };
  const flushTimers = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  const flushNextTimer = () => { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); };
  const loading = (node = source) => { node.hidden = false; node.textContent = '載入中…'; mutate(node); flushFrames(); };
  return { toast, page, source, other, mutate, flushFrames, flushTimers, flushNextTimer, loading, feedback: context.window.DKAdminFeedback };
}

test('successful load clearing its inline message dismisses global loading', () => {
  const s = setup(); s.loading(); assert.equal(s.toast.hidden, false);
  s.source.hidden = true; s.source.textContent = ''; s.mutate(s.source); s.flushTimers();
  assert.equal(s.toast.hidden, true);
});
test('navigation hiding a parent and detached source both dismiss loading', () => {
  for (const detach of [false, true]) {
    const s = setup(); s.loading();
    if (detach) s.source.isConnected = false; else s.page.hidden = true;
    s.mutate(s.page); s.flushTimers(); assert.equal(s.toast.hidden, true);
  }
});
test('completion from an older source cannot close another source loading', () => {
  const s = setup(); s.loading(); s.loading(s.other);
  s.source.hidden = true; s.mutate(s.source); s.flushTimers();
  assert.equal(s.toast.hidden, false);
  s.other.hidden = true; s.mutate(s.other); s.flushTimers(); assert.equal(s.toast.hidden, true);
});
test('error replaces loading and survives the old hide animation', () => {
  const s = setup(); s.loading(); s.source.textContent = '載入失敗'; s.mutate(s.source);
  // Run only the old hide animation, before the error auto-dismiss timer.
  s.flushNextTimer(); assert.equal(s.toast.hidden, false);
  s.flushFrames(); assert.equal(s.toast.children[1].children[0].textContent, '操作失敗');
  assert.equal(s.toast.hidden, false);
});
test('manual dismissal before animation frame cannot resurrect toast', () => {
  const s = setup(); s.feedback.show('載入中…', 'loading'); s.feedback.hide();
  s.flushFrames(); s.flushTimers(); assert.equal(s.toast.hidden, true);
  assert.equal(s.toast.classList.contains('show'), false);
});
test('same loading text can be shown again immediately after completion', () => {
  const s = setup(); s.loading(); s.source.textContent = ''; s.mutate(s.source); s.flushTimers();
  s.loading(); assert.equal(s.toast.hidden, false);
});
