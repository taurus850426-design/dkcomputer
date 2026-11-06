const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const read=f=>fs.readFileSync(f,'utf8'),wait=()=>new Promise(r=>setTimeout(r,20));
const id='11111111-1111-4111-8111-111111111111';
async function shop({linked=false,linkFailure=false,status='paid',environment='live'}={}){
 const dom=new JSDOM('<details id="webShopOrders"><button id="webShopRefresh"></button><button id="webShopPrev"></button><button id="webShopNext"></button><p id="webShopMessage"></p><div id="webShopList"></div></details>',{url:'https://example.com',runScripts:'outside-only'}),w=dom.window,calls=[],opens=[];
 const row={id,order_no:'WEB1',customer:{name:'<unsafe>',fulfillment:'pickup'},items:[{name:'PC',qty:1,unit_price:6000}],subtotal:6000,shipping_fee:0,status,environment,payment:'transfer',updated_at:'v1'};
 w.AbortSignal=AbortSignal;w.DK={getSupabaseProjectUrl:()=> 'https://project.example',getSupabaseRestAuthHeaders:async()=>({ok:true,headers:{Authorization:'Bearer admin'}})};
 w.DKShopOrderEditor={open:r=>{opens.push(r);return true;}};
 w.fetch=async(url,opt)=>{calls.push({url,body:opt.body?JSON.parse(opt.body):null});return opt.body?{ok:true,json:async()=>({rows:[row],hasMore:false})}:{ok:!linkFailure,json:async()=>linked?[{shop_order_id:id,core_order_id:'CORE1'}]:[]};};
 w.eval(read('shop-admin.js'));w.document.getElementById('webShopRefresh').click();await wait();return {dom,w,calls,opens};
}
test('linked WEB rows only open their existing core order; no separate payment/fulfillment buttons',async()=>{
 const s=await shop({linked:true});try{assert.equal(s.w.document.querySelector('[data-action="convert"]'),null);assert.equal(s.w.document.querySelector('[data-action="fulfill"]'),null);s.w.document.querySelector('[data-action="open_core"]').click();assert.equal(s.opens[0].core_order_id,'CORE1');assert.equal(s.calls.filter(c=>c.body&&c.body.action!=='list').length,0);}finally{s.dom.window.close();}
});
test('conversion starts review without writing; failed link read blocks unsafe conversion; test and fulfilled rows cannot convert',async()=>{
 for(const options of [{},{linkFailure:true},{environment:'test'},{status:'fulfilled'},{status:'awaiting_confirmation'}]){
  const s=await shop(options);try{const btn=s.w.document.querySelector('[data-action="convert"]');if(!Object.keys(options).length){assert.ok(btn);btn.click();assert.equal(s.opens.length,1);assert.equal(s.opens[0].id,id);}else assert.equal(btn,null);assert.equal(s.calls.filter(c=>c.body&&c.body.action!=='list').length,0);}finally{s.dom.window.close();}
 }
});
test('actual order editor brings WEB source into an empty review, no invented inventory mapping, and preserves dirty drafts',()=>{
 const dom=new JSDOM(read('admin.html'),{url:'https://example.com/admin.html',runScripts:'outside-only'}),w=dom.window,src=read('admin3.js');let dirty=false,opened=[],writes=0;
 Object.assign(w,{stage7IsAdminRole:()=>true,orderForm:w.document.getElementById('orderForm'),todayStr:()=> '2026-11-07',updateV2OrderGrossDisplay:()=>{},orderGuard:{dirty:()=>dirty},DK:{getOrders:()=>[{id:'CORE1'}]},alert:()=>{},pendingShopOrder:null,openV2OrderEditor:key=>{opened.push(key);w.orderForm.hidden=false;writes+=0;}});
 const start=src.indexOf('    window.DKShopOrderEditor ='),end=src.indexOf('    function updateV2OrderGrossDisplay()',start);w.eval(src.slice(start,end));
 const row={id,order_no:'WEB<script>',updated_at:'v1',status:'paid',environment:'live',subtotal:30000,shipping_fee:100,payment:'transfer',customer:{name:'Buyer',phone:'0912345678',fulfillment:'delivery',address:'Test address'},items:[{name:'New PC',qty:1}]};
 try{
  assert.equal(w.DKShopOrderEditor.open(row),true);assert.equal(opened[0],null);assert.equal(writes,0);assert.equal(w.document.getElementById('shopOrderReviewed').checked,false);assert.equal(w.pendingShopOrder.id,id);assert.equal(w.document.getElementById('orderStatus').value,'confirmed');assert.equal(w.document.getElementById('orderReceivedAmount').value,'30100');assert.equal(w.document.getElementById('orderTotalSale').value,'30000');assert.match(w.document.getElementById('shopOrderSourceBanner').textContent,/實際零件或整機/);assert.equal(w.document.getElementById('shopOrderSourceBanner').querySelector('script'),null);
  dirty=true;assert.equal(w.DKShopOrderEditor.open({...row,core_order_id:'CORE1'}),false);assert.equal(opened.length,1);dirty=false;assert.equal(w.DKShopOrderEditor.open({...row,core_order_id:'CORE1'}),true);assert.equal(opened[1],'CORE1');
 }finally{dom.window.close();}
});
test('actual serializer routes only WEB source creates through atomic conversion RPC',async()=>{
 const dom=new JSDOM('',{runScripts:'outside-only'}),w=dom.window,calls=[],src=read('shared.js');
 Object.assign(w,{stage7Rpc:async(name,args)=>{calls.push({name,args});return {ok:true,data:{id:'core'}};},stage7MapOrderWriteError:r=>r,stage7OrderLinesPayload:x=>x});
 const start=src.indexOf('async function stage7CreateOrder('),end=src.indexOf('async function stage7UpdateOrder(',start);w.eval(src.slice(start,end));
 try{await w.stage7CreateOrder({shop_source:{id,version:'v1'},salesType:'整機',items:[]});await w.stage7CreateOrder({salesType:'整機',items:[]});assert.equal(calls[0].name,'backoffice_convert_shop_order');assert.equal(calls[0].args.p_shop_id,id);assert.equal(calls[1].name,'backoffice_create_order_checked');}finally{dom.window.close();}
});
