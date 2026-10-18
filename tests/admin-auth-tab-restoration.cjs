const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','admin3.js'),'utf8');
const start=source.indexOf('    function switchV2Tab(name) {');
const end=source.indexOf('    if (typeof window.__adminV2TabSwitch',start);
assert.ok(start>=0 && end>start);
function setup({pending=false,authed=false,allowed=false}={}) {
  const state={pending,authed,allowed,denied:0,active:[],rendered:[]};
  const window={get __dkAuthBootPending(){return state.pending},DK:{isAdminAuthed:()=>state.authed}};
  const context={window,canPerm:()=>state.allowed,requirePerm:()=>state.denied++,
    applyV2TabActive:n=>state.active.push(n),v2Tabs:[],v2Panels:[],document:{getElementById:()=>null},
    renderV2Items:()=>state.rendered.push('items'),refreshReplenishmentUI:()=>{},
    renderV2Ledger:()=>state.rendered.push('ledger'),renderV2Orders:()=>state.rendered.push('orders'),
    renderV2Expenses:()=>state.rendered.push('expenses'),renderV2Reports:()=>state.rendered.push('reports'),syncAdminNav:()=>{}};
  const switchTab=new Function(...Object.keys(context),source.slice(start,end)+';return switchV2Tab;')(...Object.values(context));
  return {state,switchTab};
}
test('restoring protected tabs during session verification never alerts or renders',()=>{
  for(const name of ['ledger','expenses','reports']) {
    const s=setup({pending:true});s.switchTab(name);
    assert.equal(s.state.denied,0);assert.deepEqual(s.state.active,[]);assert.deepEqual(s.state.rendered,[]);
  }
});
test('restoration resumes after the verified profile arrives',()=>{
  const s=setup({pending:true});s.switchTab('reports');
  s.state.pending=false;s.state.authed=true;s.state.allowed=true;s.switchTab('reports');
  assert.equal(s.state.denied,0);assert.deepEqual(s.state.active,['reports']);assert.deepEqual(s.state.rendered,['reports']);
});
test('a signed-out background refresh does not raise a permission dialog',()=>{
  const s=setup();s.switchTab('reports');assert.equal(s.state.denied,0);assert.deepEqual(s.state.rendered,[]);
});
test('verified users without permission are still denied',()=>{
  const s=setup({authed:true});s.switchTab('reports');assert.equal(s.state.denied,1);assert.deepEqual(s.state.active,[]);
});
test('verified allowed inventory navigation renders normally',()=>{
  const s=setup({authed:true,allowed:true});s.switchTab('items');assert.deepEqual(s.state.rendered,['items']);assert.equal(s.state.denied,0);
});
