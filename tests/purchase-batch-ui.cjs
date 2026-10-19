const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {JSDOM}=require(process.env.JSDOM_PATH || 'jsdom');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
function setup(extra={}){
 const dom=new JSDOM(read('admin.html'),{url:'https://test.invalid',runScripts:'outside-only'}),w=dom.window;
 let calls=0;
 const fixture={id:'po',orderNo:'PO-TEST',cloudUpdatedAt:'v1',updatedAt:'2026-10-19',status:'ordered',items:[{id:'a',requestText:'CPU',category:'CPU',quantity:1,selectedUnitPrice:100,selectedVendor:'vendor',procurementStatus:'ordered',...extra}]};
 w.DK={loadPurchaseOrdersRaw:()=>[fixture],getOrders:()=>extra.sourceSalesOrderId?[{id:extra.sourceSalesOrderId,status:'completed'}]:[],fetchV2DataFromSupabase:async()=>{}};
 w.stage7IsAdminRole=()=>true;
 w.eval(read('purchase-receive-batch.js'));
 w.stage7ReceivePurchaseItem=async p=>{calls++;p.purchase_order.items.find(i=>i.id===p.purchase_item_id).procurementStatus='received';p.purchase_order.status='received';p.purchase_order.cloudUpdatedAt='v2';return {ok:true};};
 const hook='window.batchTest={set:o=>currentOrder=normalizeOrder(o),get:()=>currentOrder,open:openBulkReceiveModal,close:closeBulkReceiveModal,save:saveBulkReceiveModal,refresh:renderBulkReceivePlan,busy:()=>purchaseOperationBusy};';
 w.eval(read('purchase-orders.js').replace(/\}\)\(\);\s*$/,hook+'})();'));w.batchTest.set(fixture);
 return {dom,w,api:w.batchTest,el:id=>w.document.getElementById(id),calls:()=>calls};
}
test('opening and cancelling confirmation makes no receipt writes',()=>{
 const s=setup();s.api.open();assert.equal(s.el('poBulkReceiveModal').hidden,false);assert.equal(s.calls(),0);s.api.close();assert.equal(s.el('poBulkReceiveModal').hidden,true);assert.equal(s.calls(),0);s.dom.window.close();
});
test('explicit agreement receives pending items and displays result',async()=>{
 const s=setup();s.api.open();assert.equal(s.el('poBulkReceiveSaveBtn').disabled,false);await s.api.save();assert.equal(s.calls(),1);assert.equal(s.api.get().items[0].procurementStatus,'received');assert.match(s.el('poBulkReceiveMsg').textContent,/已登記 1 項/);assert.equal(s.api.busy(),false);s.dom.window.close();
});
test('unquoted rows disable confirmation and cannot be received by calling save',async()=>{
 const s=setup({selectedUnitPrice:0});s.api.open();assert.equal(s.el('poBulkReceiveSaveBtn').disabled,true);await s.api.save();assert.equal(s.calls(),0);s.dom.window.close();
});
test('completed source requires review checkbox before bulk receipts',async()=>{
 const s=setup({sourceSalesOrderId:'old',sourceSalesOrderLineKey:'line'});s.api.open();assert.equal(s.el('poBulkReceiveReviewField').hidden,false);assert.equal(s.el('poBulkReceiveSaveBtn').disabled,true);await s.api.save();assert.equal(s.calls(),0);
 s.el('poBulkReceiveReviewed').checked=true;s.api.refresh();assert.equal(s.el('poBulkReceiveSaveBtn').disabled,false);await s.api.save();assert.equal(s.calls(),1);s.dom.window.close();
});
test('document edits after opening confirmation require a fresh preview',async()=>{
 const s=setup();s.api.open();s.api.get().note='new draft';await s.api.save();assert.equal(s.calls(),0);assert.match(s.el('poBulkReceiveMsg').textContent,/單據已變更/);s.dom.window.close();
});
