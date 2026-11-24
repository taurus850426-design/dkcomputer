const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
function setup({ok=true,delayed=false}={}){
 const dom=new JSDOM(read('admin.html'),{url:'https://test.invalid',runScripts:'outside-only'}),w=dom.window;let writes=0,finish;
 const order={id:'po',orderNo:'PO-TEST',status:'draft',items:[{id:'item',requestText:'Keyboard',category:'鍵盤',quantity:1,procurementStatus:'pending'}]};
 let orders=[order];w.DK={loadPurchaseOrdersRaw:()=>structuredClone(orders),savePurchaseOrdersRaw:r=>orders=structuredClone(r),getOrders:()=>[],upsertPurchaseOrderToSupabase:async()=>{writes++;if(delayed)await new Promise(r=>finish=r);return {ok,error:ok?'':'offline'};},fetchV2DataFromSupabase:async()=>{}};
 const quotes=[{id:'quote',vendor:'虹友',category:'鍵盤',spec:'Keyboard',price:800,date:'2026-10-22'}];
 w.DKPurchaseBridge={
   getVendors:()=>['虹友','廠商 B','廠商 C'],
   loadVendorQuotes:()=>quotes,
   createVendorQuote:async data=>{
     const quote={...data,id:'new-'+quotes.length};
     quotes.push(quote);
     return {ok:true,quote,cloud:{ok:true}};
   }
 };
 const hook='window.quoteTest={set:o=>currentOrder=normalizeOrder(o),get:()=>currentOrder,open:openQuoteModal,apply:applyQuoteToModalItem,save:saveQuoteModal};';w.eval(read('purchase-orders.js').replace(/\}\)\(\);\s*$/,hook+'})();'));w.quoteTest.set(order);w.quoteTest.open('item');
 return {dom,w,api:w.quoteTest,modal:()=>w.document.getElementById('poQuoteModal'),writes:()=>writes,finish:()=>finish()};
}
test('successful quote adoption closes the modal automatically',async()=>{const s=setup();await s.api.apply('quote');assert.equal(s.writes(),1);assert.equal(s.modal().hidden,true);s.dom.window.close();});
test('unconfirmed cloud adoption leaves the modal and error visible',async()=>{const s=setup({ok:false});await s.api.apply('quote');assert.equal(s.modal().hidden,false);assert.match(s.w.document.getElementById('poQuoteMsg').textContent,/未確認/);s.dom.window.close();});
test('double adoption waits for one acknowledgement before closing',async()=>{const s=setup({delayed:true}),first=s.api.apply('quote');await Promise.resolve();await s.api.apply('quote');assert.equal(s.writes(),1);assert.equal(s.modal().hidden,false);s.finish();await first;assert.equal(s.modal().hidden,true);s.dom.window.close();});
test('late adoption completion does not close a different order modal',async()=>{const s=setup({delayed:true}),first=s.api.apply('quote');await Promise.resolve();s.api.set({id:'other',orderNo:'PO-OTHER',status:'draft',items:[{id:'other-item',requestText:'Other',quantity:1}]});s.api.open('other-item');s.finish();await first;assert.equal(s.modal().hidden,false);assert.match(s.w.document.getElementById('poQuoteItemSummary').textContent,/Other/);s.dom.window.close();});

test('three new quotes can be compared and adopted in the same open modal',async()=>{
 const s=setup();
 try {
   const document=s.w.document;
   for(const [vendor,price] of [['虹友',950],['廠商 B',750],['廠商 C',850]]){
     document.getElementById('poQuoteVendor').value=vendor;
     document.getElementById('poQuotePrice').value=price;
     await s.api.save();
     assert.equal(s.modal().hidden,false);
   }
   for(const id of ['new-1','new-2','new-3']){
     assert.equal(document.querySelector(`[data-poq-apply="${id}"]`)?.disabled,false);
   }
   assert.equal(s.writes(),0);
   document.querySelector('[data-poq-apply="new-2"]').click();
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(s.writes(),1);
   assert.equal(s.api.get().items[0].selectedUnitPrice,750);
   assert.equal(s.modal().hidden,true);
 } finally { s.dom.window.close(); }
});
