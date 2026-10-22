const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const read=name=>fs.readFileSync(require('node:path').join(__dirname,'..',name),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(name='order'){
 const dom=new JSDOM('<section id="editor"><input id="customer"></section><button id="destination" data-tab="purchase">採購</button><button id="orderCancel">取消</button>',{url:'https://test.invalid/admin.html',runScripts:'outside-only'}),w=dom.window;
 w.eval(read('admin-unsaved.js'));let writes=0,navigations=0,ok=true,resolve,wait=false;
 const root=w.document.getElementById('editor'),input=w.document.getElementById('customer');
 const guard=w.DKUnsaved.register(name,{label:name==='order'?'訂單':'叫貨單',root,read:()=>({customer:input.value}),save:async()=>{writes++;if(wait)await new Promise(r=>resolve=r);if(ok)guard.clean();return ok;},discard:()=>{root.hidden=true;guard.reset();}});
 guard.clean();w.document.getElementById('destination').addEventListener('click',()=>navigations++);
 return {dom,w,root,input,guard,writeCount:()=>writes,navCount:()=>navigations,setOk:x=>ok=x,setWait:()=>wait=true,resolve:()=>resolve(),click:()=>w.document.getElementById('destination').click(),choose:c=>w.document.querySelector('[data-choice="'+c+'"]').click()};
}
test('untouched editor and reverted field leave without a prompt or writes',()=>{
 const s=setup();s.click();assert.equal(s.navCount(),1);assert.equal(s.w.document.querySelector('dialog'),null);
 s.input.value='customer';s.input.value='';s.click();assert.equal(s.navCount(),2);assert.equal(s.writeCount(),0);s.dom.window.close();
});
test('typed data blocks navigation; stay and Escape preserve data without writes',()=>{
 const s=setup();s.input.value='客戶';s.click();assert.equal(s.navCount(),0);s.choose('stay');assert.equal(s.input.value,'客戶');assert.equal(s.writeCount(),0);
 s.click();s.w.document.querySelector('dialog').dispatchEvent(new s.w.Event('cancel',{cancelable:true}));assert.equal(s.w.document.querySelector('dialog'),null);assert.equal(s.input.value,'客戶');s.dom.window.close();
});
test('discard is explicit, never saves, and resumes the intended destination once',()=>{
 const s=setup();s.input.value='客戶';s.click();s.choose('discard');assert.equal(s.navCount(),1);assert.equal(s.writeCount(),0);assert.equal(s.root.hidden,true);s.dom.window.close();
});
test('save waits for acknowledgement before leaving; repeated click cannot duplicate saves',async()=>{
 const s=setup();s.input.value='客戶';s.setWait();s.click();s.choose('save');s.choose('save');assert.equal(s.writeCount(),1);assert.equal(s.navCount(),0);
 s.resolve();await flush();assert.equal(s.navCount(),1);assert.equal(s.w.document.querySelector('dialog'),null);s.dom.window.close();
});
test('failed save retains the draft and never navigates',async()=>{
 const s=setup();s.input.value='客戶';s.setOk(false);s.click();s.choose('save');await flush();assert.equal(s.navCount(),0);assert.equal(s.input.value,'客戶');assert.match(s.w.document.querySelector('[data-error]').textContent,/尚未完成儲存/);s.dom.window.close();
});
test('refresh/close warns only for an active dirty editor',()=>{
 const s=setup();const fire=()=>{const e=new s.w.Event('beforeunload',{cancelable:true});s.w.dispatchEvent(e);return e.defaultPrevented;};
 assert.equal(fire(),false);s.input.value='客戶';assert.equal(fire(),true);s.guard.clean();assert.equal(fire(),false);s.input.value='next';s.root.hidden=true;assert.equal(fire(),false);s.dom.window.close();
});
function purchaseSetup(){
 const dom=new JSDOM(read('admin.html'),{url:'https://test.invalid/admin.html',runScripts:'outside-only'}),w=dom.window;
 for(const id of ['panel','tab-purchase'])w.document.getElementById(id).hidden=false;w.document.getElementById('tab-inv').hidden=true;
 let orders=[{id:'po',orderNo:'PO-TEST',createdAt:'2026-10-20',updatedAt:'2026-10-20',cloudUpdatedAt:'v1',status:'draft',items:[],note:'original'}],writes=0,ok=true;
 w.DK={canPermission:()=>true,requirePermission:()=>true,loadPurchaseOrdersRaw:()=>structuredClone(orders),savePurchaseOrdersRaw:rows=>{orders=structuredClone(rows)},upsertPurchaseOrderToSupabase:async()=>{writes++;return {ok};},getOrders:()=>[]};
 w.eval(read('admin-unsaved.js'));w.eval(read('purchase-orders.js'));w.__dkPurchaseOrdersOpen('po');
 const nav=w.document.createElement('button');nav.dataset.tab='inv';w.document.body.append(nav);let navigations=0;nav.onclick=()=>navigations++;
 return {dom,w,nav,writes:()=>writes,navCount:()=>navigations,setOk:x=>ok=x,el:id=>w.document.getElementById(id)};
}
test('real purchase editor: viewing and reverting a note do not trigger false unsaved warnings',()=>{
 const s=purchaseSetup();s.nav.click();assert.equal(s.navCount(),1);assert.equal(s.w.document.querySelector('dialog'),null);assert.equal(s.writes(),0);
 s.el('poNote').value='changed';s.el('poNote').value='original';s.nav.click();assert.equal(s.navCount(),2);assert.equal(s.w.document.querySelector('dialog'),null);s.dom.window.close();
});
test('real purchase editor: dirty note prompts, successful cloud save clears warning',async()=>{
 const s=purchaseSetup();s.el('poNote').value='changed';s.nav.click();assert.equal(s.navCount(),0);s.w.document.querySelector('[data-choice="save"]').click();await flush();await flush();assert.equal(s.writes(),1);assert.equal(s.navCount(),1);assert.equal(s.w.document.querySelector('dialog'),null);s.dom.window.close();
});
test('real purchase editor: local save with failed cloud sync still blocks leaving',async()=>{
 const s=purchaseSetup();s.setOk(false);s.el('poNote').value='changed';s.nav.click();s.w.document.querySelector('[data-choice="save"]').click();await flush();await flush();assert.equal(s.writes(),1);assert.equal(s.navCount(),0);assert.match(s.w.document.querySelector('[data-error]').textContent,/尚未完成儲存/);s.dom.window.close();
});
test('delayed background refresh never changes purchase navigation; active orders refresh renders content only',()=>{
 const source=read('admin3.js'),start=source.indexOf('    window.__adminV2Refresh = function () {'),end=source.indexOf('    if (!window.__dkCloudAutoSyncInitialized)',start);
 const state={hidden:true,rendered:[],tab:'purchase'},window={DK:{isAdminAuthed:()=>true}},tabInv={get hidden(){return state.hidden}};
 const context={window,tabInv,document:{getElementById:()=>null,querySelector:()=>({getAttribute:()=> 'orders'})},canPerm:()=>true,renderV2Items:()=>{},refreshReplenishmentUI:()=>{},renderV2Ledger:()=>{},renderV2Orders:()=>state.rendered.push('orders'),renderV2Expenses:()=>{},renderV2Reports:()=>{}};
 new Function(...Object.keys(context),source.slice(start,end))(...Object.values(context));
 window.__adminV2Refresh();assert.deepEqual(state.rendered,[]);assert.equal(state.tab,'purchase');state.hidden=false;window.__adminV2Refresh();assert.deepEqual(state.rendered,['orders']);
});
function orderSetup({fail=false,delayed=false}={}){
 const dom=new JSDOM(read('admin.html'),{url:'https://test.invalid/admin.html',runScripts:'outside-only'}),w=dom.window;
 for(const id of ['panel','tab-inv','v2-orders','orderForm'])w.document.getElementById(id).hidden=false;
 w.eval(read('admin-unsaved.js'));let writes=0,resolve;
 w.DK={getOrders:()=>[],createOrder:async()=>{writes++;if(delayed)await new Promise(r=>resolve=r);return fail?{ok:false,error:'網路中斷'}:{ok:true,data:{id:'saved-order'}};}};
 const doc=w.document;doc.getElementById('orderNo').value='ORD-TEST';doc.getElementById('orderSalesType').value='整機';doc.getElementById('orderCustomerSource').value=[...doc.getElementById('orderCustomerSource').options].find(o=>o.value).value;
 const source=read('admin3.js'),a=source.indexOf('    let orderEditorGeneration = 0;'),b=source.indexOf('    const orderReceivedAmountEl',a),c=source.indexOf('    async function saveV2Order()'),d=source.indexOf('    makeSearchableItemSelect("orderLineItem"',c);
 w.eval('const orderForm=document.getElementById("orderForm"),orderMsg=document.getElementById("orderMsg"),orderReceivedAmountEl=document.getElementById("orderReceivedAmount");let editingV2OrderId=null,editingV2OrderVersion=null,orderLineItems=[];const DK=window.DK;const requirePerm=()=>true,clearPendingCustomerOrderLink=()=>{},v2Show=(el,m)=>{el.hidden=false;el.textContent=m},v2Hide=el=>{el.hidden=true},auditAction=()=>{},showSyncToast=()=>{},renderV2Orders=()=>{},renderV2Items=()=>{},renderV2Reports=()=>{},loadCustomerRecords=()=>[],crNormalize=x=>x,saveCustomerRecords=()=>{},saveCustomerRecordToCloud=()=>Promise.resolve(),safeParse=(v,f)=>v?JSON.parse(v):f,PENDING_CUSTOMER_ORDER_LINK_KEY="test";'+source.slice(a,b)+source.slice(c,d)+'window.orderTest={guard:orderGuard,save:saveV2Order,fill:()=>{orderLineItems=[{name:"CPU",category:"處理器",qty:1,unit_price:100,fulfillment_type:"service"}];document.getElementById("orderTotalSale").value="100"}};');
 w.orderTest.guard.clean();w.orderTest.fill();doc.getElementById('orderCustomer').value='客戶';
 const nav=doc.createElement('button');nav.dataset.tab='purchase';doc.body.append(nav);let navigations=0;nav.onclick=()=>navigations++;
 return {dom,w,nav,api:w.orderTest,writes:()=>writes,navCount:()=>navigations,resolve:()=>resolve()};
}
test('real order save validation blocks leaving and preserves entered data',async()=>{
 const s=orderSetup();s.w.document.getElementById('orderSalesType').value='';s.nav.click();s.w.document.querySelector('[data-choice="save"]').click();await flush();assert.equal(s.writes(),0);assert.equal(s.navCount(),0);assert.match(s.w.document.getElementById('orderMsg').textContent,/銷售類型/);assert.equal(s.w.document.getElementById('orderCustomer').value,'客戶');s.dom.window.close();
});
test('real order save failure keeps the editor and dirty state',async()=>{
 const s=orderSetup({fail:true});s.nav.click();s.w.document.querySelector('[data-choice="save"]').click();await flush();assert.equal(s.writes(),1);assert.equal(s.navCount(),0);assert.equal(s.api.guard.dirty(),true);assert.match(s.w.document.getElementById('orderMsg').textContent,/網路中斷/);s.dom.window.close();
});
test('real order save acknowledgement permits one navigation and clears the draft',async()=>{
 const s=orderSetup();s.nav.click();s.w.document.querySelector('[data-choice="save"]').click();await flush();assert.equal(s.writes(),1);assert.equal(s.navCount(),1);assert.equal(s.w.document.getElementById('orderForm').hidden,true);s.dom.window.close();
});
test('changes entered during order saving remain unsaved and prevent leaving',async()=>{
 const s=orderSetup({delayed:true}),promise=s.api.save();s.w.document.getElementById('orderCustomer').value='儲存中新增的內容';s.resolve();assert.equal(await promise,false);assert.equal(s.api.guard.dirty(),true);assert.equal(s.w.document.getElementById('orderForm').hidden,false);assert.match(s.w.document.getElementById('orderMsg').textContent,/尚未儲存/);s.dom.window.close();
});
