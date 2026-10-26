const {test}=require('node:test'),assert=require('node:assert/strict');
const {filter}=require('../admin-record-history.js'),batch=require('../purchase-receive-batch.js');
test('order UI searches history by phone despite the active view and a current-month date filter',()=>{
 const fs=require('fs'),source=fs.readFileSync(require('path').join(__dirname,'../admin3.js'),'utf8'),start=source.indexOf('    function getFilteredOrders()'),end=source.indexOf('    /**',start);
 const rows=[{status:'completed',order_no:'OLD',customer_phone:'0912345678',date:'2020-01-01'},{status:'confirmed',order_no:'NEW',date:'2026-10-26'}];
 const run=new Function('DK','window','document','orderSearchEl','orderDateRangeEl','orderStatusFilterEl','getOrderDateStr',source.slice(start,end)+';return getFilteredOrders();');
 const result=run({getOrders:()=>rows,enrichOrder:x=>x},{DKRecordHistory:{filter}},{getElementById:()=>({value:'active'})},{value:'091234'},{value:'month'},{value:'confirmed'},o=>o.date);
 assert.deepEqual(result.map(x=>x.order_no),['OLD']);
});
test('orders default to active, history retains completed/refunded, and search finds old customer contacts',()=>{
 const rows=[{order_no:'1',status:'confirmed'},{order_no:'2',status:'completed',customer_name:'客戶',customer_phone:'0912345678'},{order_no:'3',status:'refunded'}],before=JSON.stringify(rows);
 assert.deepEqual(filter(rows,{type:'order'}).map(x=>x.order_no),['1']);assert.deepEqual(filter(rows,{type:'order',view:'history'}).map(x=>x.order_no),['2','3']);
 assert.equal(filter(rows,{type:'order',query:'091234'}).length,1);assert.equal(filter(rows,{type:'order',query:'客戶'}).length,1);assert.equal(filter(rows,{type:'order',view:'all'}).length,3);assert.equal(JSON.stringify(rows),before);
});
test('purchase history hides only received/cancelled, not partial or completed-source pending goods',()=>{
 const rows=['draft','ordered','partial','received','cancelled'].map((status,i)=>({orderNo:String(i),status,sourceCustomerName:'客戶',sourceSalesOrderNo:'ORD-OLD'}));
 assert.deepEqual(filter(rows,{type:'purchase'}).map(x=>x.status),['draft','ordered','partial']);assert.deepEqual(filter(rows,{type:'purchase',view:'history'}).map(x=>x.status),['received','cancelled']);assert.equal(filter(rows,{type:'purchase',query:'ORD-OLD'}).length,5);
});
test('completion receipt review limits plan and writes to that customer, skipping already-received items',async()=>{
 const order={id:'po',status:'ordered',items:[{id:'a',sourceSalesOrderId:'a',sourceSalesOrderLineKey:'1',quantity:1,category:'CPU',procurementStatus:'ordered'},{id:'b',sourceSalesOrderId:'b',sourceSalesOrderLineKey:'2',quantity:1,category:'CPU',procurementStatus:'ordered'},{id:'old',sourceSalesOrderId:'a',quantity:1,procurementStatus:'received'}]};
 const options={sourceOrderId:'a',destination:'auto',priceOf:()=>100,orders:[{id:'a',status:'confirmed'},{id:'b',status:'confirmed'}]},plan=batch.plan(order,options);
 assert.deepEqual(plan.ready.map(x=>x.id),['a']);assert.equal(plan.alreadyReceived,1);assert.deepEqual(plan.issues,[]);const calls=[];
 const result=await batch.run(order,plan,{date:'2026-10-26',receive:async p=>{calls.push(p.purchase_item_id);order.items.find(i=>i.id===p.purchase_item_id).procurementStatus='received';order.status='partial';return {ok:true}}});
 assert.equal(result.error,'');assert.deepEqual(calls,['a']);assert.equal(order.items[1].procurementStatus,'ordered');assert.equal(order.status,'partial');
});
