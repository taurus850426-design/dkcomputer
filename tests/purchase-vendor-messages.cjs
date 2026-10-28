const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const item=(id,vendor='易飛',extra={})=>({id,selectedSpec:'AMD R5 7500F',quantity:2,selectedVendor:vendor,selectedUnitPrice:4350,procurementStatus:'pending',...extra});
const order=(id,items,extra={})=>({id,orderNo:'PO-'+id,status:'draft',createdAt:'2026-10-28',updatedAt:'2026-10-28',items,...extra});
function setup(orders=[]){
 const dom=new JSDOM(read('admin.html'),{url:'https://test.invalid',runScripts:'outside-only'}),w=dom.window;
 const copied=[];
 w.DK={loadPurchaseOrdersRaw:()=>orders};
 Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>copied.push(text)}});
 w.eval(read('purchase-orders.js').replace(/\}\)\(\);\s*$/,'window.msgTest={text:buildVendorText,groups:vendorBatchRows,open:openVendorBatch,bind};})();'));
 return {dom,w,api:w.msgTest,copied,el:id=>w.document.getElementById(id)};
}
test('inquiry and confirmed order have distinct intent, compact rows and no customer leakage',()=>{
 const s=setup();
 try{
  const row=item('a','易飛',{itemNote:'客戶：王先生｜請用盒裝'}),o=order('1',[row],{sourceCustomerName:'王先生',note:'王先生'});
  const before=JSON.stringify(o);
  const inquiry=s.api.text(o,'易飛',o.items,'inquiry'),confirmed=s.api.text(o,'易飛',o.items,'order');
  assert.match(inquiry,/詢價（尚未下單）/);assert.match(inquiry,/請先不要出貨/);assert.doesNotMatch(inquiry,/4,350|確認訂購/);
  assert.match(confirmed,/以下品項確認訂購/);assert.match(confirmed,/1\. AMD R5 7500F × 2｜報價單價：NT\$4,350/);
  assert.match(confirmed,/缺貨或價格異動/);
  for(const text of [inquiry,confirmed]){assert.doesNotMatch(text,/王先生|客戶：/);assert.match(text,/請用盒裝/);}
  assert.equal(JSON.stringify(o),before);
 }finally{s.dom.window.close();}
});
test('vendor batch spans orders and excludes ordered, received, cancelled and deleted lines',()=>{
 const orders=[order('1',[item('a'),item('b','立曜'),item('c','易飛',{procurementStatus:'received'})]),order('2',[item('d')]),order('3',[item('e')],{status:'ordered'}),order('4',[item('f')],{status:'cancelled'}),order('5',[item('g')],{deletedAt:'2026-10-28'}),order('6',[item('h'),item('i','易飛',{procurementStatus:'ordered'})],{status:'partial'})];
 const s=setup(orders);try{
  const before=JSON.stringify(orders),groups=s.api.groups(orders);
  assert.deepEqual(Array.from(groups.get('易飛'),row=>row.item.id),['a','d','h']);
  assert.deepEqual(Array.from(groups.get('立曜'),row=>row.item.id),['b']);
  assert.equal(JSON.stringify(orders),before);
 }finally{s.dom.window.close();}
});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('only explicitly checked rows for one vendor are copied without writing business records',async()=>{
 const orders=[order('1',[item('a'),item('b','立曜')],{sourceCustomerName:'客人甲'}),order('2',[item('c')])];
 const s=setup(orders);try{
  const before=JSON.stringify(orders);s.api.open();
  const section=s.el('poVendorBatchRows').firstElementChild;
  section.querySelector('[data-batch-mode="order"]').click();await tick();assert.equal(s.copied.length,0);
  section.querySelectorAll('input')[1].checked=true;
  section.querySelector('[data-batch-mode="order"]').click();await tick();
  assert.equal(s.copied.length,1);assert.equal((s.copied[0].match(/AMD R5/g)||[]).length,1);
  assert.match(s.copied[0],/廠商：易飛/);assert.doesNotMatch(s.copied[0],/立曜|PO-|客人甲/);
  assert.equal(JSON.stringify(orders),before);
 }finally{s.dom.window.close();}
});
test('unquoted lines allow inquiry but block confirmed order; changed data requires reopening',async()=>{
 const orders=[order('1',[item('a','易飛',{selectedUnitPrice:null})])];
 const s=setup(orders);try{
  s.api.open();let section=s.el('poVendorBatchRows').firstElementChild;
  section.querySelector('input').checked=true;
  section.querySelector('[data-batch-mode="order"]').click();await tick();assert.equal(s.copied.length,0);
  section.querySelector('[data-batch-mode="inquiry"]').click();await tick();assert.equal(s.copied.length,1);
  orders[0].items[0].selectedUnitPrice=4400;
  section.querySelector('[data-batch-mode="order"]').click();await tick();assert.equal(s.copied.length,1);assert.match(s.el('poVendorBatchMsg').textContent,/資料已變更/);
  s.api.open();section=s.el('poVendorBatchRows').firstElementChild;assert.equal(section.querySelector('input').checked,false);
  section.querySelector('input').checked=true;section.querySelector('[data-batch-mode="order"]').click();await tick();assert.equal(s.copied.length,2);assert.match(s.copied[1],/4,400/);
 }finally{s.dom.window.close();}
});
test('unknown vendor cannot be confirmed and escaped supplier/spec names stay text',async()=>{
 const s=setup([order('1',[item('a','',{selectedSpec:'<img src=x onerror=alert(1)>'})])]);
 try{s.api.open();const section=s.el('poVendorBatchRows').firstElementChild;assert.equal(section.querySelector('img'),null);section.querySelector('input').checked=true;section.querySelector('[data-batch-mode="order"]').click();await tick();assert.equal(s.copied.length,0);}finally{s.dom.window.close();}
});
