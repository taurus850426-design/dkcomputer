const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8').replace(/\r\n/g,'\n');
test('Stage 36 with real existing order/cost/receipt SQL functions',async t=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;
    create function public.dk_require_backoffice() returns text language sql as $$ select 'admin'::text $$;
    create function public.is_admin() returns boolean language sql as $$ select true $$;`);
  const base=read('supabase-stage7-v2-normalization.sql');
  for(const name of ['inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs','orders','order_costs','order_items','order_item_costs']){
   const start=base.indexOf('CREATE TABLE IF NOT EXISTS public.'+name+' (');assert.ok(start>=0,name);
   await db.exec(base.slice(start,base.indexOf('\n);',start)+3));
  }
  await db.exec('alter table public.orders add column completed_at timestamptz');
  const vp=read('supabase-vendor-purchase-sync.sql');const start=vp.indexOf('CREATE TABLE IF NOT EXISTS purchase_orders (');
  await db.exec(vp.slice(start,vp.indexOf('\n);',start)+3));
  const stage21=read('supabase-stage21-order-save-integrity.sql');const note=stage21.indexOf('CREATE OR REPLACE FUNCTION public.backoffice_set_order_quote_note(');
  await db.exec(stage21.slice(note,stage21.indexOf('$$;',note)+3));
  for(const file of ['supabase-stage22-order-procurement-link.sql','supabase-stage23-procurement-flow.sql','supabase-stage24-order-analysis.sql',
    'supabase-stage25-order-auto-inventory.sql','supabase-stage25-1-receipt-destination.sql','supabase-stage27-order-operations.sql','supabase-stage36-operation-integrity.sql','supabase-stage36-operation-integrity-enforce.sql','supabase/migrations/20261028050858_purchase_shortage_resolution.sql'])await db.exec(read(file));
  const payload={order_no:'TEST-REAL',customer_name:'測試客戶',status:'confirmed',sales_type:'new',payment_status:'unpaid',received_amount:0,delivery_status:'pending',
    items:[{line_key:'cpu',fulfillment_type:'procurement',name:'CPU BLACK',category:'CPU',qty:1,unit_price:85000,quote_unit_price:0}],quote_note:'原備註'};
  let salesId,po;
  const getOrder=async()=>(await db.query('select to_jsonb(o) row from public.orders o where id=$1',[salesId])).rows[0].row;
  const savePO=async(row,version,action={type:'save'})=>(await db.query('select public.backoffice_purchase_operation($1::jsonb,$2,$3::jsonb) result',[JSON.stringify(row),version,JSON.stringify(action)])).rows[0].result;
  await t.test('create keeps total, customer note, zero display price and unpaid state',async()=>{
   salesId=(await db.query('select public.backoffice_create_order_checked($1::jsonb) result',[JSON.stringify(payload)])).rows[0].result.id;
   const o=await getOrder();assert.equal(Number(o.total_sale),85000);assert.equal(o.extra.quote_note,'原備註');assert.equal(o.extra.payment_status,'unpaid');
   const line=(await db.query('select * from public.order_items where order_id=$1',[salesId])).rows[0];assert.equal(line.extra.quote_unit_price,0);
  });
  await t.test('PO quotation and actual procurement cost snapshot commit together',async()=>{
   const row={id:'po-real',order_no:'PO-TEST-REAL',status:'ordered',created_at:'2026-10-16T00:00:00Z',updated_at:'2026-10-16T00:00:00Z',data_json:{},items_json:[{
    id:'poi-real',requestText:'CPU BLACK',selectedSpec:'CPU BLACK',category:'CPU',quantity:1,selectedUnitPrice:4350,selectedVendor:'vendor-A',selectedQuoteId:'quote-A',quotedAt:'2026-10-16',
    sourceSalesOrderId:salesId,sourceSalesOrderLineKey:'cpu',procurementStatus:'pending'}]};
   po=(await savePO(row,null)).purchase_order;
   const cost=(await db.query('select cogs_total from public.order_costs where order_id=$1',[salesId])).rows[0];assert.equal(Number(cost.cogs_total),4350);
   const changed=structuredClone(po);changed.items_json[0].selectedUnitPrice=4500;changed.items_json[0].selectedVendor='vendor-B';
   po=(await savePO(changed,po.updated_at)).purchase_order;
   const snapshot=(await db.query('select * from public.procurement_cost_snapshots where order_id=$1',[salesId])).rows[0];assert.equal(snapshot.vendor,'vendor-B');assert.equal(Number(snapshot.unit_cost),4500);
  });
  await t.test('actual receipt creates IN/OUT reservation once and preserves sales total',async()=>{
   po=(await savePO(po,po.updated_at,{type:'receive',purchase_item_id:'poi-real',destination:'customer',received_at:'2026-10-16',note:'測試'})).purchase_order;
   assert.equal(po.status,'received');const itemId=po.items_json[0].receiptInventoryItemId;assert.ok(itemId);
   assert.equal(Number((await db.query('select qty_on_hand from public.inventory_items where id=$1',[itemId])).rows[0].qty_on_hand),0);
   assert.equal((await db.query('select * from public.inventory_ledger where item_id=$1',[itemId])).rows.length,2);
   assert.equal(Number((await getOrder()).total_sale),85000);
   await assert.rejects(savePO(po,po.updated_at,{type:'receive',purchase_item_id:'poi-real',destination:'customer',received_at:'2026-10-16'}),/已到貨/);
   assert.equal((await db.query('select * from public.inventory_ledger where item_id=$1',[itemId])).rows.length,2);
  });
  await t.test('actual destination change releases reservation without a second inbound receipt',async()=>{
   po=(await savePO(po,po.updated_at,{type:'destination',purchase_item_id:'poi-real',destination:'inventory',note:'轉一般庫存'})).purchase_order;
   const id=po.items_json[0].receiptInventoryItemId;
   assert.equal(Number((await db.query('select qty_on_hand from public.inventory_items where id=$1',[id])).rows[0].qty_on_hand),1);
   assert.equal((await db.query("select * from public.inventory_ledger where ref_type='PURCHASE_RECEIPT' and item_id=$1",[id])).rows.length,1);
   po=(await savePO(po,po.updated_at,{type:'destination',purchase_item_id:'poi-real',destination:'customer',note:'回客戶訂單'})).purchase_order;
   assert.equal(Number((await db.query('select qty_on_hand from public.inventory_items where id=$1',[id])).rows[0].qty_on_hand),0);
  });
  await t.test('legacy split-operation receipt mismatch stops for reconciliation without duplicating stock',async()=>{
   const legacy={id:'po-legacy-split',order_no:'PO-LEGACY',status:'ordered',created_at:'2026-10-16T00:00:00Z',data_json:{},items_json:[{
    id:'legacy-item',requestText:'LEGACY CPU',category:'CPU',quantity:1,selectedUnitPrice:100,selectedVendor:'vendor',procurementStatus:'ordered'}]};
   const pending=(await savePO(legacy,null)).purchase_order;
   const received=(await db.query("select public.backoffice_receive_purchase_item('','','po-legacy-split','legacy-item','','LEGACY CPU','CPU',1,100,'vendor','2026-10-16','legacy split') result")).rows[0].result;
   await assert.rejects(savePO(pending,pending.updated_at,{type:'receive',purchase_item_id:'legacy-item',destination:'inventory',received_at:'2026-10-16'}),/已有入庫流水/);
   assert.equal(Number((await db.query('select qty_on_hand from public.inventory_items where id=$1',[received.item_id])).rows[0].qty_on_hand),1);
   assert.equal((await db.query("select status from public.purchase_orders where id='po-legacy-split'")).rows[0].status,'ordered');
   assert.equal((await db.query("select * from public.inventory_ledger where ref_type='PURCHASE_RECEIPT' and item_id=$1",[received.item_id])).rows.length,1);
  });
  await t.test('after receipt existing order can be paid, delivered and completed atomically',async()=>{
   const o=await getOrder();const lines=(await db.query('select * from public.order_items where order_id=$1',[salesId])).rows;
   const items=lines.map(l=>({...l.extra,item_id:l.item_id,sku:l.sku,name:l.name,spec:l.spec,qty:l.qty,unit_price:l.unit_price}));
   await db.query('select public.backoffice_update_order_checked($1,$2::jsonb)',[o.updated_at,JSON.stringify({...payload,id:salesId,status:'completed',payment_status:'paid',received_amount:85000,payment_date:'2026-10-16',delivery_status:'delivered',delivered_at:'2026-10-16',items})]);
   const after=await getOrder();assert.equal(after.status,'completed');assert.equal(after.extra.payment_status,'paid');assert.equal(Number(after.total_sale),85000);
  });
 }finally{await db.close()}
});
