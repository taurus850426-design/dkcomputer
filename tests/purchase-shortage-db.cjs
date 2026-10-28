const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8').replace(/\r\n/g,'\n');
const migration='supabase/migrations/20261028050858_purchase_shortage_resolution.sql';
test('shortage operations with real cost and receipt functions in isolated Postgres',async t=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
   create function public.dk_require_backoffice() returns text language sql as $$ select current_setting('test.role',true) $$;
   create function public.is_admin() returns boolean language sql as $$ select current_setting('test.role',true)='admin' $$;set test.role='admin';`);
  const base=read('supabase-stage7-v2-normalization.sql');
  for(const name of ['inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs','orders','order_costs','order_items','order_item_costs']){
   const start=base.indexOf('CREATE TABLE IF NOT EXISTS public.'+name+' (');await db.exec(base.slice(start,base.indexOf('\n);',start)+3));
  }
  await db.exec('alter table public.orders add column completed_at timestamptz');
  const vp=read('supabase-vendor-purchase-sync.sql'),start=vp.indexOf('CREATE TABLE IF NOT EXISTS purchase_orders (');await db.exec(vp.slice(start,vp.indexOf('\n);',start)+3));
  const stage21=read('supabase-stage21-order-save-integrity.sql'),note=stage21.indexOf('CREATE OR REPLACE FUNCTION public.backoffice_set_order_quote_note(');await db.exec(stage21.slice(note,stage21.indexOf('$$;',note)+3));
  for(const file of ['supabase-stage22-order-procurement-link.sql','supabase-stage23-procurement-flow.sql','supabase-stage24-order-analysis.sql','supabase-stage25-order-auto-inventory.sql','supabase-stage25-1-receipt-destination.sql','supabase-stage27-order-operations.sql','supabase-stage36-operation-integrity.sql','supabase-stage36-operation-integrity-enforce.sql'])await db.exec(read(file));
  const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
  const write=async(po,action={type:'save'},version=po.updated_at)=>(await one('select public.backoffice_purchase_operation($1::jsonb,$2,$3::jsonb) result',[JSON.stringify(po),version,JSON.stringify(action)])).result.purchase_order;
  let po,salesId;
  const getPO=async()=>JSON.parse(JSON.stringify((await one('select to_jsonb(p) row from public.purchase_orders p where id=$1',[po.id])).row));
  const getSales=async()=>(await one('select to_jsonb(o) row from public.orders o where id=$1',[salesId])).row;
  const ledgerCount=async()=>Number((await one('select count(*) n from public.inventory_ledger')).n);
  const act=async(mode,extra={})=>({type:'shortage',purchase_item_id:'a',mode,reason:'供應商缺貨',supplier_confirmed:true,expected_source_updated_at:(await getSales()).updated_at,...extra});
  await t.test('install is repeatable and does not modify existing business rows',async()=>{
   salesId=(await one('select public.backoffice_create_order_checked($1::jsonb) result',[JSON.stringify({order_no:'SHORTAGE-TEST',customer_name:'客戶',sales_type:'new',status:'confirmed',discount:100,items:[{line_key:'cpu',fulfillment_type:'procurement',name:'原 CPU',spec:'原 CPU',category:'CPU',qty:1,unit_price:10000}]} )])).result.id;
   po=await write({id:'shortage-po',order_no:'PO-SHORTAGE',status:'ordered',created_at:'2026-10-28',items_json:[{id:'a',requestText:'原 CPU',selectedSpec:'原 CPU',category:'CPU',quantity:1,selectedVendor:'廠商A',selectedUnitPrice:4000,procurementStatus:'ordered',sourceSalesOrderId:salesId,sourceSalesOrderLineKey:'cpu'},{id:'b',selectedSpec:'機殼',category:'CASE',quantity:1,selectedVendor:'廠商C',selectedUnitPrice:1000,procurementStatus:'ordered'}],data_json:{}},undefined,null);
   const before=JSON.stringify(await getPO());await db.exec(read(migration));await db.exec(read(migration));assert.equal(JSON.stringify(await getPO()),before);
  });
  await t.test('waiting and restoring supply preserve quotes and prevent premature receipts',async()=>{
   po=await write(po,await act('wait',{expected_date:'2026-11-03'}));assert.equal(po.items_json[0].shortageState,'waiting');assert.equal(po.items_json[0].selectedUnitPrice,4000);
   await assert.rejects(write(po,{type:'receive',purchase_item_id:'a',destination:'customer',received_at:'2026-10-28'}),/目前不可登記到貨/);assert.equal(await ledgerCount(),0);
   po=await write(po,await act('resume'));assert.equal(po.items_json[0].shortageState,'');assert.equal(po.data_json.shortageHistory.length,2);
  });
  await t.test('replacement updates cost and optionally customer specs, while sale/discount/other rows stay intact',async()=>{
   const oldSales=await getSales(),beforeB=JSON.stringify(po.items_json[1]);
   po=await write(po,await act('replace',{vendor:'廠商B',spec:'替代 CPU',unit_price:5000,quantity:1,sync_spec:true,quoted_at:'2026-10-28'}));
   assert.equal(po.items_json[0].selectedSpec,'替代 CPU');assert.equal(po.items_json[0].shortageState,'replacement_pending');assert.equal(JSON.stringify(po.items_json[1]),beforeB);
   assert.equal(Number((await one('select cogs_total from public.order_costs where order_id=$1',[salesId])).cogs_total),5000);
   const line=await one('select * from public.order_items where order_id=$1',[salesId]);assert.equal(line.name,'替代 CPU');assert.equal(line.spec,'替代 CPU');
   const after=await getSales();assert.equal(after.total_sale,oldSales.total_sale);assert.equal(after.discount,oldSales.discount);assert.equal(await ledgerCount(),0);
   assert.equal(po.data_json.shortageHistory[2].before.selectedVendor,'廠商A');assert.equal(po.data_json.shortageHistory[2].before.selectedUnitPrice,4000);
   await assert.rejects(write(po,{type:'receive',purchase_item_id:'a',destination:'customer',received_at:'2026-10-28'}),/目前不可登記到貨/);
  });
  await t.test('stale PO/source versions, bad quantities and unconfirmed vendor changes roll back completely',async()=>{
   const before=JSON.stringify(await getPO()),salesBefore=JSON.stringify(await getSales());
   await assert.rejects(write(po,await act('vendor',{vendor:'廠商D',unit_price:6000,supplier_confirmed:false})),/請先確認原廠商/);
   await assert.rejects(write(po,await act('replace',{vendor:'廠商D',unit_price:6000,spec:'錯誤數量',quantity:2,sync_spec:true})),/數量不可直接變更/);
   await assert.rejects(write(po,await act('vendor',{vendor:'廠商D',unit_price:6000,expected_source_updated_at:'2020-01-01'})),/客戶訂單已更新/);
   await assert.rejects(write(po,await act('vendor',{vendor:'廠商D',unit_price:6000}),'2020-01-01'),/其他裝置更新/);
   assert.equal(JSON.stringify(await getPO()),before);assert.equal(JSON.stringify(await getSales()),salesBefore);
  });
  await t.test('vendor-only replacement leaves customer specifications and selling price unchanged',async()=>{
   po=await write(po,await act('vendor',{vendor:'廠商D',unit_price:4500}));assert.equal(po.items_json[0].selectedSpec,'替代 CPU');
   assert.equal((await one('select spec from public.order_items where order_id=$1',[salesId])).spec,'替代 CPU');
   assert.equal(po.data_json.shortageHistory.length,4);
  });
  await t.test('cost-sync failure rolls back specification, history, source version and PO together',async()=>{
   await db.exec(`create function public.fail_shortage_cost() returns trigger language plpgsql as $$ begin if new.cost_unit=7777 then raise exception 'injected cost failure'; end if;return new;end $$;
    create trigger fail_shortage_cost before insert or update on public.order_item_costs for each row execute function public.fail_shortage_cost();`);
   const before=JSON.stringify(await getPO()),salesBefore=JSON.stringify(await getSales()),lineBefore=JSON.stringify((await db.query('select * from public.order_items where order_id=$1',[salesId])).rows);
   await assert.rejects(write(po,await act('replace',{vendor:'廠商X',spec:'不應留存的規格',unit_price:7777,quantity:1,sync_spec:true})),/injected cost failure/);
   assert.equal(JSON.stringify(await getPO()),before);assert.equal(JSON.stringify(await getSales()),salesBefore);assert.equal(JSON.stringify((await db.query('select * from public.order_items where order_id=$1',[salesId])).rows),lineBefore);
  });
  await t.test('completed source blocks replacement even if purchase row still says ordered',async()=>{
   // An old completed record can exist from before the receipt guard; do not disable that guard.
   await db.query(`insert into public.orders select (jsonb_populate_record(null::public.orders,to_jsonb(o)||jsonb_build_object('id','legacy-completed','order_no','LEGACY-COMPLETED','status','completed','extra',o.extra||'{"delivery_status":"delivered"}'::jsonb))).* from public.orders o where id=$1`,[salesId]);
   const linked=JSON.parse(JSON.stringify(po.items_json));linked[0].sourceSalesOrderId='legacy-completed';
   await db.query('update public.purchase_orders set items_json=$2::jsonb where id=$1',[po.id,JSON.stringify(linked)]);
   try{await assert.rejects(write(po,await act('vendor',{vendor:'廠商E',unit_price:4200})),/已結案/);}
   finally{await db.query('update public.purchase_orders set items_json=$2::jsonb where id=$1',[po.id,JSON.stringify(po.items_json)]);}
  });
  await t.test('cancel archives original, removes active line, clears cost and preserves customer demand',async()=>{
   po=await write(po,await act('cancel'));assert.equal(po.items_json.length,1);assert.equal(po.items_json[0].id,'b');assert.equal(po.status,'ordered');
   assert.equal(po.data_json.shortageHistory.at(-1).before.selectedVendor,'廠商D');assert.equal(po.data_json.shortageHistory.at(-1).after,null);
   assert.equal(Number((await one('select cogs_total from public.order_costs where order_id=$1',[salesId])).cogs_total),0);
   assert.equal((await db.query('select * from public.order_items where order_id=$1',[salesId])).rows.length,1);assert.equal(await ledgerCount(),0);
   const altered=JSON.parse(JSON.stringify(po));altered.data_json.shortageHistory=[];po=await write(altered);assert.equal(po.data_json.shortageHistory.length,5);
  });
  await t.test('received rows cannot be changed; staff cannot invoke shortage writes',async()=>{
   po=await write(po,{type:'receive',purchase_item_id:'b',destination:'inventory',received_at:'2026-10-28'});const before=JSON.stringify(po);
   await assert.rejects(write(po,{type:'shortage',purchase_item_id:'b',mode:'cancel',reason:'已到貨不應修改'}),/目前狀態不可處理缺貨|已到貨/);
   await db.exec("set test.role='staff'");await assert.rejects(write(po,{type:'shortage',purchase_item_id:'b',mode:'cancel',reason:'staff'}),/admin only/);await db.exec("set test.role='admin'");
   assert.equal(JSON.stringify(await getPO()),before);assert.equal(await ledgerCount(),1);
   const permissions=await one("select has_function_privilege('anon','public.backoffice_purchase_operation(jsonb,text,jsonb)','execute') anon,has_function_privilege('authenticated','public.backoffice_purchase_operation(jsonb,text,jsonb)','execute') authenticated");assert.equal(permissions.anon,false);assert.equal(permissions.authenticated,true);
  });
  await t.test('replacement can be received only after explicit supplier order confirmation',async()=>{
   let other=await write({id:'replacement-unlinked',order_no:'PO-NEW',status:'ordered',created_at:'2026-10-28',items_json:[{id:'a',selectedSpec:'原規格',category:'CPU',quantity:1,selectedVendor:'A',selectedUnitPrice:100,procurementStatus:'ordered'}],data_json:{}},undefined,null);
   other=await write(other,{type:'shortage',purchase_item_id:'a',mode:'replace',spec:'新規格',vendor:'B',unit_price:200,quantity:1,supplier_confirmed:true,reason:'缺貨'});
   const invalid=JSON.parse(JSON.stringify(other));invalid.items_json[0].shortageState='';await assert.rejects(write(invalid),/缺貨狀態請使用/);
   const removed=JSON.parse(JSON.stringify(other));removed.items_json=[];await assert.rejects(write(removed),/缺貨品項請使用/);
   await assert.rejects(write(other,{type:'shortage',purchase_item_id:'a',mode:'ordered',reason:'已送單',supplier_confirmed:false}),/確認替代品/);
   other=await write(other,{type:'shortage',purchase_item_id:'a',mode:'ordered',reason:'廠商確認接單',supplier_confirmed:true});assert.equal(other.items_json[0].procurementStatus,'ordered');assert.equal(other.items_json[0].shortageState,'');
   other=await write(other,{type:'receive',purchase_item_id:'a',destination:'inventory',received_at:'2026-10-28'});assert.equal(other.status,'received');assert.equal(other.items_json[0].selectedSpec,'新規格');assert.equal(other.data_json.shortageHistory.length,2);
  });
 }finally{await db.close();}
});
