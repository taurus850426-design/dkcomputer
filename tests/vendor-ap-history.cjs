const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
test('AP history filters desktop and mobile without changing records or payment totals',()=>{
 const dom=new JSDOM(read('admin.html'),{runScripts:'outside-only'}),w=dom.window;
 try{
  const src=read('admin3.js'),el=id=>w.document.getElementById(id);
  const render=src.slice(src.indexOf('    function apRenderList(rows)'),src.indexOf('    function apRenderSettings()'));
  const compute=src.slice(src.indexOf('    function apComputeKpi(rows)'),src.indexOf('    function apRenderKpi(rows)'));
  const bind=src.match(/    apEl\("apHistoryView"\)\?\.addEventListener\("change",[^\n]+/)[0];
  w.apRows=['DRAFT','MISMATCH','CONFIRMED','PAID','VOID'].map(status=>({id:status,status,system_amount:100,vendor_claimed_amount:100,difference:0,paid_amount:100,paid_at:new Date().toISOString()}));
  const snapshot=JSON.stringify(w.apRows);
  w.apEl=el;w.root=el('apWorkspace');w.apLoading=false;
  w.apShow=(e,s)=>{e.textContent=s;e.hidden=!s;};w.v2Esc=s=>String(s??'');
  w.apFmtNT=String;w.apFmtDate=String;w.apStatusBadge=String;w.apPaidLabel=String;w.apDiffClass=()=>'';w.apOpenDetail=id=>{w.opened=id;};w.apToNum=n=>Number(n);
  w.eval(compute+render+bind);
  const ids=()=>[...el('apListTbody').querySelectorAll('button')].map(b=>b.dataset.id);
  const mobile=()=>[...el('apListCards').querySelectorAll('button')].map(b=>b.dataset.id);
  const totals=JSON.stringify(w.apComputeKpi(w.apRows));
  w.apRenderList(w.apRows);assert.deepEqual(ids(),['DRAFT','MISMATCH','CONFIRMED']);assert.deepEqual(mobile(),ids());
  el('apHistoryView').value='history';el('apHistoryView').dispatchEvent(new w.Event('change'));
  assert.deepEqual(ids(),['PAID','VOID']);assert.deepEqual(mobile(),ids());
  el('apListCards').querySelector('button').click();assert.equal(w.opened,'PAID');
  el('apHistoryView').value='all';el('apHistoryView').dispatchEvent(new w.Event('change'));assert.equal(ids().length,5);
  assert.equal(JSON.stringify(w.apRows),snapshot);assert.equal(JSON.stringify(w.apComputeKpi(w.apRows)),totals);
  el('apHistoryView').value='active';w.apRenderList(w.apRows.filter(r=>['PAID','VOID'].includes(r.status)));assert.match(el('apListState').textContent,/歷史紀錄/);assert.equal(ids().length,0);
  w.apLoading=true;w.apRenderList([]);assert.equal(el('apListState').textContent,'載入中…');
 }finally{w.close();}
});
