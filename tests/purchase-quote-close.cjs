const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
function setup({ok=true,delayed=false}={}){
 const dom=new JSDOM(read('admin.html'),{url:'https://test.invalid',runScripts:'outside-only'}),w=dom.window;let writes=0,finish;
 const order={id:'po',orderNo:'PO-TEST',status:'draft',items:[{id:'item',requestText:'Keyboard',category:'鍵盤',quantity:1,procurementStatus:'pending'}]};
 let orders=[order];w.DK={loadPurchaseOrdersRaw:()=>structuredClone(orders),savePurchaseOrdersRaw:r=>orders=structuredClone(r),getOrders:()=>[],upsertPurchaseOrderToSupabase:async()=>{writes++;if(delayed)await new Promise(r=>finish=r);return {ok,error:ok?'':'offline'};},fetchV2DataFromSupabase:async()=>{}};
 w.DKPurchaseBridge={getVendors:()=>['虹友'],loadVendorQuotes:()=>[{id:'quote',vendor:'虹友',category:'鍵盤',spec:'Keyboard',price:800,date:'2026-10-22'}]};
 const hook='window.quoteTest={set:o=>currentOrder=normalizeOrder(o),open:openQuoteModal,apply:applyQuoteToModalItem};';w.eval(read('purchase-orders.js').replace(/\}\)\(\);\s*$/,hook+'})();'));w.quoteTest.set(order);w.quoteTest.open('item');
 return {dom,w,api:w.quoteTest,modal:()=>w.document.getElementById('poQuoteModal'),writes:()=>writes,finish:()=>finish()};
}
test('successful quote adoption closes the modal automatically',async()=>{const s=setup();await s.api.apply('quote');assert.equal(s.writes(),1);assert.equal(s.modal().hidden,true);s.dom.window.close();});
test('unconfirmed cloud adoption leaves the modal and error visible',async()=>{const s=setup({ok:false});await s.api.apply('quote');assert.equal(s.modal().hidden,false);assert.match(s.w.document.getElementById('poQuoteMsg').textContent,/未確認/);s.dom.window.close();});
test('double adoption waits for one acknowledgement before closing',async()=>{const s=setup({delayed:true}),first=s.api.apply('quote');await Promise.resolve();await s.api.apply('quote');assert.equal(s.writes(),1);assert.equal(s.modal().hidden,false);s.finish();await first;assert.equal(s.modal().hidden,true);s.dom.window.close();});
test('late adoption completion does not close a different order modal',async()=>{const s=setup({delayed:true}),first=s.api.apply('quote');await Promise.resolve();s.api.set({id:'other',orderNo:'PO-OTHER',status:'draft',items:[{id:'other-item',requestText:'Other',quantity:1}]});s.api.open('other-item');s.finish();await first;assert.equal(s.modal().hidden,false);assert.match(s.w.document.getElementById('poQuoteItemSummary').textContent,/Other/);s.dom.window.close();});
