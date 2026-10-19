const {test}=require('node:test');
const assert=require('node:assert/strict');
const {plan,run,pendingForOrder}=require('../purchase-receive-batch.js');
const item=(id,extra={})=>({id,requestText:id,quantity:1,category:'處理器',price:100,procurementStatus:'quoted',...extra});
const order=(items)=>({id:'po',status:'ordered',cloudUpdatedAt:'v1',items});
const options=(extra={})=>({destination:'auto',priceOf:i=>i.price,orders:[],...extra});
test('plan skips received items and routes linked and stock items explicitly',()=>{
 const po=order([item('done',{procurementStatus:'received'}),item('customer',{sourceSalesOrderId:'o1',sourceSalesOrderLineKey:'k1'}),item('stock')]);
 const batch=plan(po,options({orders:[{id:'o1',status:'pending'}]}));
 assert.deepEqual(batch.issues,[]);assert.equal(batch.alreadyReceived,1);assert.deepEqual(batch.ready.map(x=>[x.id,x.destination]),[['customer','customer'],['stock','inventory']]);
});
test('missing quote, category or invalid quantity blocks the whole confirmation',()=>{
 const batch=plan(order([item('a',{price:0}),item('b',{category:''}),item('c',{quantity:0})]),options());assert.equal(batch.issues.length,3);
});
test('completed linked orders require explicit legacy-stock review',()=>{
 const po=order([item('a',{sourceSalesOrderId:'old',sourceSalesOrderLineKey:'k'})]);
 const opts=options({orders:[{id:'old',status:'completed'}]});assert.ok(plan(po,opts).issues.length);assert.equal(plan(po,{...opts,allowCompleted:true}).issues.length,0);
});
test('refunded or unavailable linked orders are not received in bulk',()=>{
 const po=order([item('a',{sourceSalesOrderId:'old',sourceSalesOrderLineKey:'k'})]);assert.ok(plan(po,options()).issues.length);assert.ok(plan(po,options({orders:[{id:'old',status:'refunded'}]})).issues.length);
});
test('customer-only mode cannot silently put unlinked items into stock',()=>{assert.ok(plan(order([item('a')]),options({destination:'customer'})).issues.length);});
test('draft and fully-received orders cannot be batch received',()=>{
 const po=order([item('a')]);po.status='draft';assert.ok(plan(po,options()).issues.length);assert.ok(plan(order([item('a',{procurementStatus:'received'})]),options()).issues.length);
});
test('receipts are sequential and each operation uses the updated order version',async()=>{
 const po=order([item('a'),item('b')]),batch=plan(po,options()),versions=[];let active=0,max=0;
 const res=await run(po,batch,{date:'2026-10-19',receive:async p=>{active++;max=Math.max(max,active);versions.push(p.purchase_order.cloudUpdatedAt);await new Promise(r=>setImmediate(r));p.purchase_order.items.find(i=>i.id===p.purchase_item_id).procurementStatus='received';p.purchase_order.cloudUpdatedAt='v2';active--;return {ok:true};}});
 assert.deepEqual(versions,['v1','v2']);assert.equal(max,1);assert.deepEqual(res.completed,['a','b']);assert.equal(res.error,'');
});
test('midway failure preserves successes and stops before later items',async()=>{
 const po=order([item('a'),item('b'),item('c')]),calls=[];
 const res=await run(po,plan(po,options()),{date:'2026-10-19',receive:async p=>{calls.push(p.purchase_item_id);if(p.purchase_item_id==='b')return {ok:false,error:'version conflict'};po.items[0].procurementStatus='received';return {ok:true};}});
 assert.deepEqual(calls,['a','b']);assert.deepEqual(res.completed,['a']);assert.match(res.error,/version conflict/);assert.notEqual(po.items[2].procurementStatus,'received');
});
test('duplicate batch submissions do not issue duplicate receipt operations',async()=>{
 const po=order([item('a')]),batch=plan(po,options());let finish,calls=0;
 const first=run(po,batch,{receive:()=>{calls++;return new Promise(r=>finish=r)}});
 const second=await run(po,batch,{receive:()=>{calls++}});assert.match(second.error,/處理中/);assert.equal(calls,1);po.items[0].procurementStatus='received';finish({ok:true});await first;
});
test('invalid confirmation plan never reaches the receipt service',async()=>{
 let calls=0;const po=order([item('a',{price:0})]);await run(po,plan(po,options()),{receive:()=>calls++});assert.equal(calls,0);
});
test('unknown receipt result stops without inventing received status',async()=>{
 const po=order([item('a'),item('b')]);const res=await run(po,plan(po,options()),{receive:async()=>undefined});assert.equal(res.completed.length,0);assert.notEqual(po.items[0].procurementStatus,'received');assert.ok(res.error);
});
test('pending links cover all purchase orders without including another customers items',()=>{
 const one={id:'p1',sourceSalesOrderId:'o1',status:'partial',items:[item('a'),item('done',{procurementStatus:'received'}),item('other',{sourceSalesOrderId:'o2'})]};
 const two={id:'p2',status:'ordered',items:[item('b',{sourceSalesOrderId:'o1'})]};
 const cancelled={...two,id:'p3',status:'cancelled'};
 const rows=pendingForOrder('o1',[one,two,cancelled]);assert.deepEqual(rows.map(r=>r.items.map(i=>i.id)),[['a'],['b']]);assert.deepEqual(pendingForOrder('',[one]),[]);
});

test('quick order completion with pending linked purchases performs no order write',async()=>{
 const fs=require('node:fs'),path=require('node:path');
 const source=fs.readFileSync(path.join(__dirname,'..','admin3.js'),'utf8');
 const start=source.indexOf('    async function quickCompleteOrderState('),end=source.indexOf('    ordersTbody?.addEventListener',start);
 let writes=0,opened='';
 const po={id:'po1',orderNo:'PO-1',status:'ordered',sourceSalesOrderId:'sales',items:[item('pending')]};
 const DK={getOrders:()=>[{id:'sales',delivery_status:'delivered'}],enrichOrder:x=>x,updateOrder:async()=>{writes++;return {ok:true}}};
 const deps={requirePerm:()=>true,DK,showCenterToast:()=>{},pendingLinkedPurchases:id=>pendingForOrder(id,[po]),pendingPurchaseMessage:()=> '尚有品項未到貨',
   window:{confirm:()=>true,__dkPurchaseOrdersOpen:id=>opened=id},canPerm:()=>true,switchTab:()=>{},refreshOrdersAfterQuickUpdate:async()=>{},auditAction:()=>{}};
 const quick=new Function(...Object.keys(deps),source.slice(start,end)+';return quickCompleteOrderState;')(...Object.values(deps));
 await quick('sales','complete');assert.equal(writes,0);assert.equal(opened,'po1');
});
