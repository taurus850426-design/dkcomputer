const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8').replace(/\r\n/g,'\n');
test('closed orders and deposit accounting',async t=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;
    create function public.dk_require_backoffice() returns text language sql as $$ select current_setting('test.role',true) $$; set test.role='admin';
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

  await db.exec(read('supabase-order-manual-cost.sql'));

  await db.exec(read('supabase-order-closed-status.sql'));await db.exec(read('supabase-order-deposit.sql'));
  const line={line_key:'svc',fulfillment_type:'service',name:'服務',category:'其他',qty:1,unit_price:1000};
  let seq=0;
  const create=async(extra={})=>(await db.query('select public.backoffice_create_order_checked($1::jsonb) result',[JSON.stringify({order_no:'CLOSE-'+(++seq),status:'negotiating',items:[line],...extra})])).rows[0].result.id;
  const get=async id=>(await db.query('select * from public.orders where id=$1',[id])).rows[0];
  const update=async(id,extra)=>{const o=await get(id);return db.query('select public.backoffice_update_order_checked($1,$2::jsonb)',[o.updated_at,JSON.stringify({id,order_no:o.order_no,status:o.status,items:[line],payment_status:o.extra.payment_status||'unpaid',received_amount:o.extra.received_amount||0,delivery_status:o.extra.delivery_status||'pending',...extra})]);};
  await t.test('negotiating can fail, history retained and cannot accidentally reactivate',async()=>{const id=await create();await update(id,{status:'lost'});assert.equal((await get(id)).status,'lost');await assert.rejects(update(id,{status:'confirmed'}),/不可重新啟用/);});
  await t.test('confirmed orders use cancelled rather than lost',async()=>{const id=await create({status:'confirmed'});await assert.rejects(update(id,{status:'lost'}),/洽談中的/);await update(id,{status:'cancelled'});assert.equal((await get(id)).status,'cancelled');});
  await t.test('cancelling returns reserved inventory once and keeps order line',async()=>{
   await db.exec("insert into public.inventory_items(id,name,category,qty_on_hand) values('stock-close','測試庫存','CPU',5);insert into public.inventory_costs(item_id,cost_unit) values('stock-close',200)");
   const stock={line_key:'stock',fulfillment_type:'inventory',item_id:'stock-close',qty:2,unit_price:1000};
   const id=await create({status:'confirmed',items:[stock]});assert.equal(Number((await db.query("select qty_on_hand from public.inventory_items where id='stock-close'")).rows[0].qty_on_hand),3);
   await update(id,{status:'cancelled',items:[stock]});await update(id,{status:'cancelled',items:[stock]});
   assert.equal(Number((await db.query("select qty_on_hand from public.inventory_items where id='stock-close'")).rows[0].qty_on_hand),5);assert.equal((await db.query('select * from public.order_items where order_id=$1',[id])).rows.length,1);
  });
  await t.test('paid or delivered orders cannot be cancelled and retain all payment data',async()=>{
   const id=await create({status:'confirmed',payment_status:'partial',received_amount:200,payment_date:'2026-10-29'});
   const before=JSON.stringify(await get(id));await assert.rejects(update(id,{status:'cancelled',payment_status:'unpaid',received_amount:0}),/已有收款/);assert.equal(JSON.stringify(await get(id)),before);
  });
  await t.test('draft procurement is cancelled with contents preserved; ordered procurement blocks closure',async()=>{
   const part={...line,fulfillment_type:'procurement'};
   for(const status of ['draft','ordered']){
    const id=await create({status:'confirmed',items:[part]});
    const row={id:'po-'+id,order_no:'PO-'+id,status,created_at:'2026-10-29',items_json:[{id:'a',quantity:1,requestText:'服務',selectedSpec:'服務',category:'其他',selectedVendor:'A',selectedUnitPrice:300,procurementStatus:status==='ordered'?'ordered':'pending',sourceSalesOrderId:id,sourceSalesOrderLineKey:'svc'}],data_json:{sourceSalesOrderId:id}};
    await db.query("select public.backoffice_purchase_operation($1::jsonb,null,'{\"type\":\"save\"}'::jsonb)",[JSON.stringify(row)]);
    if(status==='ordered'){await assert.rejects(update(id,{status:'cancelled',items:[part]}),/已叫貨或到貨/);assert.equal((await get(id)).status,'confirmed');}
    else{await update(id,{status:'cancelled',items:[part]});const po=(await db.query('select * from public.purchase_orders where id=$1',[row.id])).rows[0];assert.equal(po.status,'cancelled');assert.equal(po.items_json.length,1);}
   }
  });
  await t.test('deposit is part of cumulative receipts and persists through final payment',async()=>{
   const id=await create({status:'confirmed',payment_status:'partial',received_amount:300,payment_date:'2026-10-29',deposit_amount:300});
   assert.equal((await get(id)).extra.deposit_amount,300);assert.equal((await get(id)).extra.received_amount,300);
   await update(id,{payment_status:'paid',received_amount:1000,payment_date:'2026-10-29',deposit_amount:300});assert.equal((await get(id)).extra.received_amount,1000);assert.equal((await get(id)).extra.deposit_amount,300);
   const before=JSON.stringify(await get(id));await assert.rejects(update(id,{payment_status:'paid',received_amount:1000,payment_date:'2026-10-29',deposit_amount:1001}),/不得超過累計實收/);assert.equal(JSON.stringify(await get(id)),before);
  });
  await t.test('old receipts remain unclassified until explicitly labelled; invalid deposit cannot commit',async()=>{
   const id=await create({payment_status:'partial',received_amount:200,payment_date:'2026-10-29'});assert.equal((await get(id)).extra.deposit_amount,undefined);
   await update(id,{payment_status:'partial',received_amount:200,payment_date:'2026-10-29',deposit_amount:200});assert.equal((await get(id)).extra.received_amount,200);
   await assert.rejects(update(id,{deposit_amount:-1,payment_date:'2026-10-29'}),/訂金須為有效/);
  });
 }finally{await db.close();}
});
