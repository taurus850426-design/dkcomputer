const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {JSDOM}=require('jsdom');
const wait=()=>new Promise(resolve=>setTimeout(resolve,15));const id='00000000-0000-4000-8000-000000000001';
async function page(enabled=false,success=false,initial={}){
 const dom=new JSDOM(fs.readFileSync('shop.html','utf8'),{url:'https://example.com/dkcomputer/shop.html',runScripts:'outside-only'}),w=dom.window;
 w.DK={getSupabaseProjectUrl:()=> 'https://project.example'};w.AbortSignal=AbortSignal;w.crypto.subtle=crypto.subtle;w.TextEncoder=TextEncoder;
 for(const [key,value]of Object.entries(initial.local||{}))w.localStorage.setItem(key,value);for(const [key,value]of Object.entries(initial.session||{}))w.sessionStorage.setItem(key,value);
 const calls=[];w.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push({body,headers:options.headers});let data={};let ok=true;
  if(body.action==='config')data={enabled,mode:'manual',challenge:'signed-challenge'};
  if(body.action==='catalog')data={items:[{id:'pc',name:'Test PC',price:100,qty:3,photos:[]},{id:'mixed',name:'Multiple models',price:888,qty:8,requires_quote:true}]};
  if(body.action==='create'){ok=success;data=success?{id,order_no:'WEB1'}:{error:'測試網路中斷'};}
  if(body.action==='recover'){ok=success;data=success?{id,order_no:'WEB1'}:{error:'not found'};}
  if(body.action==='status')data={id,order_no:'WEB1',status:'awaiting_confirmation',payment:'transfer',items:[],subtotal:100};
  return {ok,json:async()=>data};
 };for(const file of ['shop-config.js','shop-core.js','shop-ui.js'])w.eval(fs.readFileSync(file,'utf8'));await wait();return {dom,w,calls};
}
function fill(w){const form=w.document.getElementById('shopForm');for(const [k,v]of Object.entries({name:'測試客戶',phone:'0912345678',email:'test@example.com',fulfillment:'pickup',payment:'transfer'}))form.elements[k].value=v;form.elements.consent.checked=true;return form;}
test('paused shop previews cart but never creates orders; inquiry products cannot be added',async()=>{
 const {dom,w,calls}=await page();w.document.querySelector('[data-shop-add="pc"]').click();assert.equal(w.document.getElementById('shopTotal').textContent,'NT$ 100');assert.equal(w.document.getElementById('shopSubmit').disabled,true);assert.equal(w.document.querySelector('[data-shop-add="mixed"]').disabled,true);assert.equal(calls.filter(x=>x.body.action==='create').length,0);assert.deepEqual(JSON.parse(w.localStorage.getItem('dk_shop_cart_v1')),[{id:'pc',qty:1}]);dom.window.close();
});
test('failed create preserves cart and idempotency key without storing contact details',async()=>{
 const {dom,w,calls}=await page(true);w.document.querySelector('[data-shop-add="pc"]').click();const form=fill(w);form.dispatchEvent(new w.Event('submit',{cancelable:true}));await wait();await wait();
 const sent=calls.find(x=>x.body.action==='create');assert.ok(sent);assert.equal(sent.body.customer.payment,'transfer');assert.equal(sent.body.challenge,'signed-challenge');assert.equal(sent.body.consent,true);assert.equal(JSON.parse(w.localStorage.getItem('dk_shop_cart_v1'))[0].qty,1);assert.ok(!JSON.stringify({...w.localStorage,...w.sessionStorage}).includes('test@example.com'));
 form.dispatchEvent(new w.Event('submit',{cancelable:true}));await wait();await wait();const again=calls.filter(x=>x.body.action==='create');assert.equal(again[0].body.key,again[1].body.key);assert.equal(again[0].body.token,again[1].body.token);dom.window.close();
});
test('successful checkout stores a durable private tracking link and clears cart only after acknowledgement',async()=>{
 const {dom,w}=await page(true,true);w.document.querySelector('[data-shop-add="pc"]').click();fill(w).dispatchEvent(new w.Event('submit',{cancelable:true}));await wait();await wait();
 assert.equal(w.localStorage.getItem('dk_shop_cart_v1'),null);const records=JSON.parse(w.localStorage.getItem('dk_shop_orders_v1'));assert.equal(records[0].id,id);assert.equal(records[0].token.length,64);assert.match(w.document.getElementById('shopTrackingLink').value,/#order=/);assert.match(w.document.getElementById('shopOrderStatus').textContent,/WEB1/);assert.ok(!JSON.stringify(records).includes('0912345678'));dom.window.close();
});
test('delivery disables store payment and HTML has no credit-card entry',async()=>{
 const {dom,w}=await page(true);const form=fill(w);form.elements.payment.value='store';form.elements.fulfillment.value='delivery';form.elements.fulfillment.dispatchEvent(new w.Event('change'));assert.equal(form.elements.payment.value,'transfer');assert.equal(form.elements.payment.querySelector('[value="store"]').disabled,true);assert.equal(form.elements.payment.querySelector('[value="credit"]'),null);assert.equal(form.elements.address.required,true);dom.window.close();
});
test('reload recovers an acknowledged order whose first response was lost without resubmitting',async()=>{
 const pending={key:'00000000-0000-4000-8000-000000000002',token:'a'.repeat(64),fingerprint:'hash',cart:[{id:'pc',qty:1}]};
 const {dom,w,calls}=await page(true,true,{local:{dk_shop_cart_v1:JSON.stringify(pending.cart)},session:{dk_shop_pending_v1:JSON.stringify(pending)}});await wait();
 assert.ok(calls.some(x=>x.body.action==='recover'));assert.equal(calls.filter(x=>x.body.action==='create').length,0);assert.equal(w.localStorage.getItem('dk_shop_cart_v1'),null);assert.equal(JSON.parse(w.localStorage.getItem('dk_shop_orders_v1'))[0].token,pending.token);dom.window.close();
});
test('admin read/refresh never marks receipt; rejected confirmation and draft refresh preserve input',async()=>{
 const dom=new JSDOM('<details id="webShopOrders"><button id="webShopRefresh"></button><button id="webShopPrev"></button><button id="webShopNext"></button><p id="webShopMessage"></p><div id="webShopList"></div></details>',{url:'https://example.com',runScripts:'outside-only'}),w=dom.window,calls=[];
 w.AbortSignal=AbortSignal;w.DK={getSupabaseProjectUrl:()=> 'https://project.example',getSupabaseRestAuthHeaders:async()=>({ok:true,headers:{Authorization:'Bearer admin'}})};w.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({rows:[{id,order_no:'WEB1',customer:{name:'<unsafe>',fulfillment:'pickup'},items:[{name:'PC',qty:1,unit_price:100}],subtotal:100,status:'awaiting_confirmation',environment:'live',payment:'transfer',updated_at:'v1'}],hasMore:false})};};w.confirm=()=>false;w.eval(fs.readFileSync('shop-admin.js','utf8'));
 assert.equal(calls.length,0);w.document.getElementById('webShopRefresh').click();await wait();assert.equal(calls[0].action,'list');assert.equal(w.document.querySelector('unsafe'),null);w.document.querySelector('[data-action="approve"]').click();await wait();assert.equal(calls.length,1);
 const input=w.document.querySelector('[data-instructions]');input.value='My bank details draft';input.dispatchEvent(new w.Event('input',{bubbles:true}));w.document.getElementById('webShopRefresh').click();await wait();assert.equal(calls.length,1);assert.equal(input.value,'My bank details draft');dom.window.close();
});
