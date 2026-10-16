const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');
const read = n => fs.readFileSync(path.join(__dirname,'..',n),'utf8').replace(/\r\n/g,'\n');
const shared=read('shared.js'), po=read('purchase-orders.js'), admin=read('admin3.js');
function fn(src,name,indent='') {
  const match=new RegExp('^'+indent+'(?:async )?function '+name+'\\(', 'm').exec(src);
  assert.ok(match,'function '+name);
  const start=match.index;
  const after=src.slice(start+match[0].length);
  const next=new RegExp('^'+indent+'(?:async )?function ', 'm').exec(after);
  return src.slice(start,next ? start+match[0].length+next.index : undefined).trim();
}
const plain = x => JSON.parse(JSON.stringify(x));
function ctx(extra={}) { return vm.createContext({console,AbortController,Set,JSON,Date,Math,...extra}); }
function poSetup() {
  const dom=new JSDOM(`<div id="poMsg"></div><div id="poQuoteMsg"></div><div id="poReceiveMsg"></div>
    <input id="poReceiveDate" value="2026-10-16"><select id="poReceiveDestination"><option value="customer">客戶</option><option value="inventory">庫存</option></select>
    <input id="poReceiveInventoryItem" value="__auto__"><input id="poReceiveNote" value="備註"><button id="poReceiveSaveBtn"></button>`,
    {url:'https://test.invalid',runScripts:'outside-only'});
  const w=dom.window;let list=[];let cloudCalls=0;
  w.DK={loadPurchaseOrdersRaw:()=>plain(list),savePurchaseOrdersRaw:rows=>{list=plain(rows)},
    fetchV2DataFromSupabase:async()=>{},upsertPurchaseOrderToSupabase:async order=>{cloudCalls++;order.cloudUpdatedAt='new';return {ok:true}}};
  const exports=`window.poTest={set:(o)=>currentOrder=normalizeOrder(o),get:()=>currentOrder,
    quote:(id)=>quoteModalItemId=id,receive:(id,mode='receive')=>{receiveModalItemId=id;receiveModalMode=mode},
    apply:applyQuoteToModalItem,saveQuote:saveQuoteModal,syncSales:syncFromSalesOrder,saveReceive:saveReceiveModal,persist:persistAsyncPurchaseOrder,busy:()=>purchaseOperationBusy};`;
  w.eval(po.replace(/\}\)\(\);\s*$/,exports+'})();'));
  return {w,api:w.poTest,dom,setList:x=>list=plain(x),getList:()=>plain(list),cloudCalls:()=>cloudCalls};
}
const fixture=(id='A')=>({id,orderNo:'PO-'+id,createdAt:'2026-10-16',updatedAt:'2026-10-16',cloudUpdatedAt:'old',status:'ordered',note:'既有備註',
  items:[{id:'item-'+id,requestText:'CPU',category:'CPU',quantity:1,selectedUnitPrice:100,selectedVendor:'舊廠商',selectedQuoteId:'old',
    sourceSalesOrderId:'sales-'+id,sourceSalesOrderLineKey:'line-'+id,costSyncedAt:'old-success',procurementStatus:'pending'}]});

test('opening purchase module performs no cloud writes or local order saves',()=>{
  const s=poSetup();assert.equal(s.cloudCalls(),0);assert.deepEqual(s.getList(),[]);s.dom.window.close();
});
test('delayed receipt response after switching A to B preserves every B field',async()=>{
  const s=poSetup();const a=fixture(),b=fixture('B');s.setList([a,b]);s.api.set(a);s.api.receive('item-A');
  let resolve;let request;
  s.w.stage7ReceivePurchaseItem=arg=>{request=arg;return new Promise(r=>resolve=r)};
  const pending=s.api.saveReceive();assert.equal(s.api.busy(),true);s.api.set(b);const beforeB=plain(s.api.get());
  request.purchase_order.items[0].procurementStatus='received';request.purchase_order.status='received';
  resolve({ok:true,data:{reserved_for_order:true}});await pending;
  assert.deepEqual(plain(s.api.get()),beforeB);
  assert.equal(s.api.get().id,'B');assert.equal(s.api.get().items[0].procurementStatus,'pending');
  assert.deepEqual(s.getList()[1],b);assert.equal(request.purchase_order_id,'A');assert.equal(s.api.busy(),false);s.dom.window.close();
});
test('failed receipt leaves original item, quantities, quote and busy lock unchanged',async()=>{
  const s=poSetup();s.api.set(fixture());s.api.receive('item-A');const before=plain(s.api.get());
  s.w.stage7ReceivePurchaseItem=async()=>({ok:false,error:'stale version'});await s.api.saveReceive();
  assert.deepEqual(plain(s.api.get()),before);assert.equal(s.api.busy(),false);assert.match(s.w.document.getElementById('poReceiveMsg').textContent,/stale version/);s.dom.window.close();
});
test('adoption serializes different quote buttons and never calls an unguarded cost RPC',async()=>{
  const s=poSetup();s.api.set(fixture());s.api.quote('item-A');s.setList([fixture()]);
  s.w.localStorage.setItem('dk_vendor_quotes_v1',JSON.stringify([{id:'q1',price:200,vendor:'廠商1',spec:'CPU'},{id:'q2',price:300,vendor:'廠商2',spec:'CPU'}]));
  let finish,calls=0,unsafe=0;s.w.stage7SyncProcurementCost=()=>unsafe++;
  s.w.DK.upsertPurchaseOrderToSupabase=()=>{calls++;return new Promise(r=>finish=r)};
  const first=s.api.apply('q1');await s.api.apply('q2');assert.equal(calls,1);assert.equal(unsafe,0);
  finish({ok:true});await first;assert.equal(s.api.get().items[0].selectedQuoteId,'q1');assert.equal(s.api.busy(),false);s.dom.window.close();
});
test('already received item refuses adopting another vendor',async()=>{
  const s=poSetup();const a=fixture();a.status='partial';a.items[0].procurementStatus='received';s.api.set(a);s.api.quote('item-A');
  s.w.localStorage.setItem('dk_vendor_quotes_v1',JSON.stringify([{id:'q1',price:200,vendor:'廠商1'}]));
  const before=plain(s.api.get());await s.api.apply('q1');assert.deepEqual(plain(s.api.get()),before);assert.equal(s.cloudCalls(),0);s.dom.window.close();
});
test('deleted target never resurrected by delayed async persist',async()=>{
  const s=poSetup();const a=fixture();s.setList([{...a,deletedAt:'2026-10-16T12:00:00Z'}]);
  const res=await s.api.persist(a);assert.equal(res.ok,false);assert.equal(s.cloudCalls(),0);assert.ok(s.getList()[0].deletedAt);s.dom.window.close();
});
test('quote display metadata preserves legacy values and whole-order accounting allocation',()=>{
  const c=ctx();vm.runInContext(fn(shared,'stage7OrderLinesPayload'),c);
  const modern=c.stage7OrderLinesPayload([{name:'CPU',qty:1,unit_price:0,quote_unit_price:0}],85000);
  assert.equal(modern[0].unit_price,85000);assert.equal(modern[0].quote_unit_price,0);
  const legacy=c.stage7OrderLinesPayload([{name:'CPU',qty:1,unit_price:85000}],85000);
  assert.equal(legacy[0].unit_price,85000);assert.equal(Object.hasOwn(legacy[0],'quote_unit_price'),false);
});
test('banner Add preserves current focus, unsaved URL and blank draft rows',()=>{
  const dom=new JSDOM('<button id="feHomeBannerAddBtn"></button><div id="feHomeBannersList"><div class="banner-row"><input class="banner-image" value="draft.jpg"><input class="banner-link" value="/new"><input class="banner-focus-x" value="12"><input class="banner-focus-y" value="89"></div><div class="banner-row"><input class="banner-image" value=""></div></div>',{runScripts:'outside-only'});
  let rows;dom.window.DK={getConfig:()=>({frontend:{homeBanners:[{image:'old.jpg'}]}})};dom.window.renderHomeBanners=(_,r)=>rows=plain(r);
  const a=admin.indexOf('  (function initHomeBannerAddBtn()');const b=admin.indexOf('\n  })();',a)+10;
  dom.window.eval(admin.slice(a,b));dom.window.document.getElementById('feHomeBannerAddBtn').click();
  assert.equal(rows.length,3);assert.deepEqual(rows[0],{image:'draft.jpg',link:'/new',focusX:12,focusY:89});assert.equal(rows[1].image,'');dom.window.close();
});
function restContext(fetch) {
  let fire,cleared=false;
  const c=ctx({fetch,setTimeout:cb=>{fire=cb;return 1},clearTimeout:()=>cleared=true,
    requireVerifiedBackofficeCloudAccess:()=>({ok:true}),getSupabaseRestAuthHeaders:async()=>({ok:true,headers:{apikey:'test',Authorization:'test'}}),
    SUPABASE_URL:'https://test.invalid',vpRestClassifyHttp:status=>status===401?'not_authenticated':status===403?'forbidden':'other'});
  vm.runInContext(fn(shared,'stage7RestJson'),c);return {c,fire:()=>fire(),cleared:()=>cleared};
}
test('REST write timeout includes body reading, aborts once, and never retries',async()=>{
  let calls=0,signal;const s=restContext(async(_,opt)=>{calls++;signal=opt.signal;return {ok:true,text:()=>new Promise(()=>{})}});
  const pending=s.c.stage7RestJson('rpc/test',{method:'POST',body:{}});await new Promise(r=>setImmediate(r));s.fire();
  const result=await pending;assert.equal(result.resultUnknown,true);assert.equal(result.timedOut,true);assert.equal(signal.aborted,true);assert.equal(calls,1);assert.equal(s.cleared(),true);
});
test('REST authentication errors and missing safe migration are explicit',async()=>{
  for (const [status,body,field] of [[401,'{}','notAuthenticated'],[403,'{}','forbidden'],[404,'{"code":"PGRST202"}','migrationRequired']]) {
    const s=restContext(async()=>({ok:false,status,text:async()=>body}));
    const result=await s.c.stage7RestJson('rpc/backoffice_purchase_operation',{method:'POST'});assert.equal(result[field],true);
  }
});
test('guarded purchase request retains original cloud version separately from local update time',async()=>{
  let rows=[fixture()],request;
  const c=ctx({__dkVpSyncGuard:{applyingCloud:false},vpEnsureTimestamps:x=>({...x}),vpNowISO:()=> 'now',
    stage7Rpc:async(name,args)=>{request={name,args};return {ok:false,error:'conflict'}},vpSaveMeta:()=>{},VP_STORAGE_KEYS:{purchaseOrdersMeta:'meta'},
    loadPurchaseOrdersRaw:()=>rows,savePurchaseOrdersRaw:x=>rows=x});
  vm.runInContext(fn(shared,'purchaseOrderToCloudRow')+'\n'+fn(shared,'cloudRowToPurchaseOrder')+'\nconst purchaseWritesInFlight=new Set();\n'+fn(shared,'upsertPurchaseOrderToSupabase'),c);
  const a=fixture();a.updatedAt='new-local-time';await c.upsertPurchaseOrderToSupabase(a);
  assert.equal(request.name,'backoffice_purchase_operation');assert.equal(request.args.p_expected_updated_at,'old');assert.equal(request.args.p_row.updated_at,'new-local-time');assert.equal(rows[0].note,'既有備註');
});
test('guarded order update carries displayed baseline and does not issue trailing partial writes',async()=>{
  const calls=[];const c=ctx({stage7Rpc:async(name,args)=>{calls.push({name,args});return {ok:true}},stage7MapOrderWriteError:x=>x,stage7OrderLinesPayload:(x)=>x});
  vm.runInContext(fn(shared,'stage7UpdateOrder'),c);await c.stage7UpdateOrder({id:'A',expected_updated_at:'original',items:[]});
  assert.equal(calls.length,1);assert.equal(calls[0].name,'backoffice_update_order_checked');assert.equal(calls[0].args.p_expected_updated_at,'original');
});
test('normal 15-item quote renders; unreadably long specifications refuse clipped output',()=>{
  const noop=()=>{};const canvas={};const drawing=new Proxy({measureText:s=>({width:String(s).length*18}),createLinearGradient:()=>({addColorStop:noop})},{get:(o,k)=>k in o?o[k]:noop,set:(o,k,v)=>{o[k]=v;return true}});
  canvas.getContext=()=>drawing;
  const c=ctx({document:{createElement:()=>canvas},fmtQuoteMoney:n=>'NT$'+n});
  vm.runInContext(fn(admin,'wrapCanvasText','    ')+'\n'+fn(admin,'roundRectPath','    ')+'\n'+fn(admin,'drawQuoteCanvas','    '),c);
  const data={items:Array.from({length:15},()=>({title:'CPU R7 9800X3D',category:'處理器',qty:1,unit_price:0})),grand:100,cashPrice:100,originalTotal:100};
  assert.equal(c.drawQuoteCanvas(data),canvas);
  assert.throws(()=>c.drawQuoteCanvas({...data,items:data.items.map(x=>({...x,title:'超長規格'.repeat(100)}))}),/A4/);
});
test('sales order edits preserve already ordered vendor, quote, quantity, specification and receipt snapshots',async()=>{
  const s=poSetup();const a=fixture();a.sourceSalesOrderId='sales-A';a.items[0].procurementStatus='ordered';a.items[0].selectedSpec='OLD CPU';
  s.setList([a]);const original=plain(a.items[0]);
  const result=await s.api.syncSales({id:'sales-A',order_no:'ORD-A',status:'confirmed',customer_name:'原客戶',items:[{
    line_key:'line-A',fulfillment_type:'procurement',name:'NEW CPU',category:'CPU',qty:2,preferred_vendor:'新廠商'}]});
  assert.equal(result.ok,true);assert.deepEqual(s.getList()[0].items[0],plain(s.api.get()?.items?.[0] || s.getList()[0].items[0]));
  const saved=s.getList()[0].items[0];for(const key of Object.keys(original))assert.deepEqual(saved[key],original[key],key);
  assert.match(result.warnings.join(' '),/保留原廠商/);s.dom.window.close();
});
test('saving a new vendor quote then switching modal cannot clear the next document form',async()=>{
  const s=poSetup();for(const [id,value] of Object.entries({poQuoteDate:'2026-10-16',poQuoteVendor:'廠商A',poQuoteCategory:'CPU',poQuoteSpec:'CPU',poQuotePrice:'100'})){
    const e=s.w.document.createElement('input');e.id=id;e.value=value;s.w.document.body.appendChild(e);
  }
  s.api.set(fixture());s.api.quote('item-A');let finish;
  s.w.DKPurchaseBridge={createVendorQuote:()=>new Promise(r=>finish=r)};
  const pending=s.api.saveQuote();assert.equal(s.api.busy(),true);
  s.api.set(fixture('B'));s.api.quote('item-B');s.w.document.getElementById('poQuoteVendor').value='B未存廠商';
  finish({ok:true,quote:{vendor:'廠商A'},cloud:{ok:true}});await pending;
  assert.equal(s.w.document.getElementById('poQuoteVendor').value,'B未存廠商');assert.equal(s.api.busy(),false);s.dom.window.close();
});
test('destination response after navigation only publishes the original captured purchase document',async()=>{
  const s=poSetup();const a=fixture();a.items[0].procurementStatus='received';a.items[0].receiptDestination='customer';
  s.api.set(a);s.api.receive('item-A','destination');s.w.document.getElementById('poReceiveDestination').value='inventory';let finish,arg;
  s.w.stage7SetPurchaseReceiptDestination=p=>{arg=p;return new Promise(r=>finish=r)};
  const pending=s.api.saveReceive();s.api.set(fixture('B'));const before=plain(s.api.get());
  arg.purchase_order.items[0].receiptDestination='inventory';finish({ok:true});await pending;
  assert.deepEqual(plain(s.api.get()),before);assert.equal(arg.purchase_order_id,'A');assert.equal(s.api.busy(),false);s.dom.window.close();
});
test('cloud reload first backs up conflicting local draft, while ordinary merge retains it',async()=>{
  let rows=[{...fixture(),updatedAt:'2099-01-01',note:'未同步草稿'}];const store=new Map();let quota=false;
  const remote={id:'A',order_no:'PO-A',status:'ordered',created_at:'2026-10-16',updated_at:'2026-10-17',note:'雲端最新',items_json:[],data_json:{}};
  const c=ctx({__dkVpSyncGuard:{purchasePull:false,applyingCloud:false},loadPurchaseOrdersRaw:()=>plain(rows),
    vpSaveMeta:(_,m)=>m,VP_STORAGE_KEYS:{purchaseOrdersMeta:'meta'},vpActiveCount:x=>x.length,vpNowISO:()=> 'now',
    vpRestFetchAll:async()=>({ok:true,rows:[remote]}),SUPABASE_PURCHASE_ORDERS_TABLE:'purchase_orders',vpParseTs:Date.parse,
    savePurchaseOrdersRaw:x=>rows=plain(x),localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>{if(quota)throw Error('quota');store.set(k,v)}}});
  vm.runInContext(fn(shared,'cloudRowToPurchaseOrder')+'\n'+fn(shared,'vpMergeByUpdatedAt')+'\n'+fn(shared,'pullPurchaseOrdersFromCloud'),c);
  await c.pullPurchaseOrdersFromCloud();assert.equal(rows[0].note,'未同步草稿');
  quota=true;const failed=await c.pullPurchaseOrdersFromCloud({preferCloudId:'A'});assert.equal(failed.ok,false);assert.equal(rows[0].note,'未同步草稿');
  quota=false;const result=await c.pullPurchaseOrdersFromCloud({preferCloudId:'A'});assert.equal(result.ok,true);assert.equal(rows[0].note,'雲端最新');assert.equal(rows[0].cloudUpdatedAt,'2026-10-17');
  const backups=JSON.parse(store.get('dk_po_conflict_drafts_v1'));assert.equal(backups[0].order.note,'未同步草稿');
});
test('cloud pagination handles a lower configured server cap and does not return partial data on failure',async()=>{
  let calls=0;const c=ctx({SUPABASE_URL:'test',SUPABASE_ANON_KEY:'test',vpRequireVerifiedAdminCloudAccess:()=>({ok:true}),
    stage7RestJson:async p=>{calls++;assert.match(p,new RegExp('offset='+((calls-1)*2)+'$'));return {ok:true,data:calls<3?[{id:calls+'a'},{id:calls+'b'}]:[]}}});
  vm.runInContext(fn(shared,'vpRestFetchAll'),c);assert.equal((await c.vpRestFetchAll('purchase_orders')).rows.length,4);assert.equal(calls,3);
  calls=0;c.stage7RestJson=async()=>++calls===1?{ok:true,data:[{id:'A'}]}:{ok:false,error:'network'};
  const result=await c.vpRestFetchAll('purchase_orders');assert.equal(result.ok,false);assert.equal(result.rows.length,0);
});
test('editing a draft sales specification retains adopted quote snapshot and handwritten PO notes',async()=>{
  const s=poSetup();const a=fixture();a.status='draft';a.sourceSalesOrderId='sales-A';a.note='整單手寫備註';a.items[0].itemNote='品項手寫備註';a.items[0].selectedSpec='原報價規格';a.customMetadata={retained:true};
  s.setList([a]);const result=await s.api.syncSales({id:'sales-A',order_no:'ORD-A',status:'confirmed',customer_name:'客戶',items:[{
    line_key:'line-A',fulfillment_type:'procurement',name:'新的需求規格',category:'CPU',qty:1,preferred_vendor:'舊廠商'}]});
  const saved=s.getList()[0];assert.equal(saved.note,'整單手寫備註');assert.equal(saved.items[0].itemNote,'品項手寫備註');
  assert.equal(saved.items[0].selectedSpec,'原報價規格');assert.equal(saved.items[0].selectedUnitPrice,100);assert.equal(saved.items[0].selectedQuoteId,'old');
  assert.equal(saved.customMetadata.retained,true);assert.match(result.warnings.join(' '),/請確認廠商報價/);s.dom.window.close();
});
