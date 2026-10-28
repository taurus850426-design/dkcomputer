const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(extra={}){
 const dom=new JSDOM(read('admin.html'),{url:'https://test.invalid',runScripts:'outside-only'}),w=dom.window;
 const item={id:'a',requestText:'原 CPU',selectedSpec:'原 CPU',selectedVendor:'廠商A',selectedUnitPrice:4000,quantity:1,procurementStatus:'ordered',sourceSalesOrderId:'s1',sourceSalesOrderLineKey:'cpu',...extra};
 const order={id:'p1',status:'ordered',items:[item],cloudUpdatedAt:'v1'};let calls=[],busy=false,saved=0;
 w.DK={getOrders:()=>[{id:'s1',updated_at:'2026-10-28T00:00:00Z'}],upsertPurchaseOrderToSupabase:async(o,a)=>{calls.push(a);return{ok:true,order:o};}};
 w.confirm=()=>true;w.eval(read('purchase-shortage.js'));w.DKPurchaseShortage.bind();
 w.DKPurchaseShortage.open({order,item,quotes:[{id:'q1',vendor:'廠商B',brand:'AMD',spec:'替代 CPU',price:5000,date:'2026-10-27'}],isBusy:()=>busy,setBusy:v=>busy=v,onSaved:async()=>saved++});
 const field=id=>w.document.getElementById('poShortage'+id);
 const mode=value=>{field('Mode').value=value;field('Mode').dispatchEvent(new w.Event('change'));};
 return{dom,w,order,item,calls,field,mode,saved:()=>saved,busy:()=>busy};
}
test('opening/cancelling makes no writes; editing protects the pending draft',()=>{
 const s=setup();try{assert.equal(s.calls.length,0);assert.equal(s.w.DKPurchaseShortage.pending(),false);s.field('Reason').value='缺貨';assert.equal(s.w.DKPurchaseShortage.pending(),true);s.w.confirm=()=>false;s.field('Close').click();assert.equal(s.field('Modal').hidden,false);s.w.confirm=()=>true;s.field('Close').click();assert.equal(s.field('Modal').hidden,true);assert.equal(s.calls.length,0);}finally{s.dom.window.close();}
});
test('replacement compares before/after and sends explicit spec-sync choice with source version',async()=>{
 const s=setup();try{
  s.mode('replace');s.field('Quote').value='0';s.field('Quote').dispatchEvent(new s.w.Event('change'));
  assert.match(s.field('Comparison').textContent,/採購總額差額：\+1000/);assert.equal(s.field('Quantity').readOnly,true);assert.equal(s.field('SyncSpec').checked,false);
  s.field('SyncSpec').checked=true;s.field('Reason').value='原型號缺貨';s.field('Confirmed').checked=true;s.field('Save').click();await tick();
  assert.equal(s.calls.length,1);assert.equal(s.calls[0].mode,'replace');assert.equal(s.calls[0].unit_price,5000);assert.equal(s.calls[0].spec,'AMD 替代 CPU');assert.equal(s.calls[0].sync_spec,true);assert.equal(s.calls[0].quote_id,'q1');assert.equal(s.calls[0].expected_source_updated_at,'2026-10-28T00:00:00Z');assert.equal(s.saved(),1);assert.equal(s.field('Modal').hidden,true);
 }finally{s.dom.window.close();}
});
test('validation and supplier confirmation block writes; switching modes clears agreement',async()=>{
 const s=setup();try{s.mode('vendor');s.field('Reason').value='缺貨';s.field('Vendor').value='廠商B';s.field('Save').click();await tick();assert.equal(s.calls.length,0);s.field('Confirmed').checked=true;s.mode('cancel');assert.equal(s.field('Confirmed').checked,false);s.field('Save').click();await tick();assert.equal(s.calls.length,0);}finally{s.dom.window.close();}
});
test('double click sends one request; ambiguous result retains modal and requires cloud review',async()=>{
 const s=setup();try{
  let finish;s.w.DK.upsertPurchaseOrderToSupabase=async(o,a)=>{s.calls.push(a);return new Promise(resolve=>finish=resolve);};
  s.field('Reason').value='缺貨';const before=JSON.stringify(s.order);s.field('Save').click();s.field('Save').click();assert.equal(s.calls.length,1);assert.equal(s.busy(),true);assert.equal(s.field('Close').disabled,true);
  finish({ok:false,error:'version conflict'});await tick();assert.equal(s.field('Modal').hidden,false);assert.equal(s.field('Save').disabled,true);assert.match(s.field('Msg').textContent,/重新從雲端同步/);assert.equal(s.saved(),0);assert.equal(JSON.stringify(s.order),before);assert.equal(s.busy(),false);
 }finally{s.dom.window.close();}
});
test('pending replacement offers explicit order confirmation and blocks duplicate save',async()=>{
 const s=setup({shortageState:'replacement_pending',procurementStatus:'pending'});try{
  assert.equal(s.field('Mode').value,'ordered');assert.equal(Array.from(s.field('Mode').options).some(o=>o.value==='wait'),false);
  s.field('Reason').value='廠商已接單';s.field('Save').click();await tick();assert.equal(s.calls.length,0);s.field('Confirmed').checked=true;s.field('Save').click();await tick();assert.equal(s.calls[0].mode,'ordered');
 }finally{s.dom.window.close();}
});
test('notification names only relevant vendor/product, without customer or internal notes',()=>{
 const s=setup();try{const text=s.w.DKPurchaseShortage.notification({mode:'vendor',before:{...s.item,itemNote:'客戶秘密'},after:{...s.item,selectedVendor:'廠商B'},reason:'客戶姓名及電話'});assert.match(text,/廠商A/);assert.match(text,/原品項取消/);assert.doesNotMatch(text,/秘密|姓名|電話|廠商B/);}finally{s.dom.window.close();}
});
test('sales-order resave cannot resurrect cancelled procurement or undo pending replacement',async()=>{
 const s=setup();try{
  let records=[{...s.order,sourceSalesOrderId:'s1',status:'ordered',items:[],shortageHistory:[{mode:'cancel',before:s.item,after:null}]}];
  s.w.DK={loadPurchaseOrdersRaw:()=>records,savePurchaseOrdersRaw:list=>records=list,upsertPurchaseOrderToSupabase:async()=>({ok:true})};
  s.w.eval(read('purchase-orders.js').replace(/\}\)\(\);\s*$/,'window.shortagePOTest={canReceiveItem,vendorBatchRows,purchaseStatusText};})();'));
  const source={id:'s1',status:'confirmed',order_no:'ORD-1',items:[{line_key:'cpu',fulfillment_type:'procurement',name:'原 CPU',spec:'原 CPU',category:'CPU',qty:1,preferred_vendor:'廠商A'}]};
  await s.w.DKPurchaseOrderSync.syncFromSalesOrder(source);assert.equal(records[0].items.length,0);
  records[0].items=[{...s.item,selectedVendor:'廠商B',selectedSpec:'替代 CPU',selectedUnitPrice:5000,procurementStatus:'pending',shortageState:'replacement_pending'}];
  await s.w.DKPurchaseOrderSync.syncFromSalesOrder(source);assert.equal(records[0].items[0].selectedVendor,'廠商B');assert.equal(records[0].items[0].selectedSpec,'替代 CPU');assert.equal(records[0].items[0].selectedUnitPrice,5000);
  const helpers=s.w.shortagePOTest;
  assert.equal(helpers.canReceiveItem(records[0],records[0].items[0]),false);
  assert.equal(helpers.vendorBatchRows(records).get('廠商B').length,1);assert.match(helpers.purchaseStatusText(records[0]),/替代品待叫貨 1 項/);
  records[0].items[0].shortageState='waiting';assert.equal(helpers.vendorBatchRows(records).size,0);assert.equal(helpers.canReceiveItem(records[0],records[0].items[0]),false);
 }finally{s.dom.window.close();}
});
