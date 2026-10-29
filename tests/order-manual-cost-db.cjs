const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8').replace(/\r\n/g,'\n');
test('manual order cost persists with real order and procurement functions',async t=>{
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
  const line={line_key:'svc',fulfillment_type:'service',category:'其他',name:'安裝服務',qty:2,unit_price:1000,manual_cost_unit:300};
  const payload={order_no:'MANUAL-COST-TEST',status:'negotiating',items:[line]};
  const create=async p=>(await db.query('select public.backoffice_create_order_checked($1::jsonb) result',[JSON.stringify(p)])).rows[0].result;
  const result=await create(payload);const id=result.id;
  const cost=async()=>Number((await db.query('select cogs_total from public.order_costs where order_id=$1',[id])).rows[0].cogs_total);
  const update=async items=>{const version=(await db.query('select updated_at from public.orders where id=$1',[id])).rows[0].updated_at;return db.query('select public.backoffice_update_order_checked($1,$2::jsonb)',[version,JSON.stringify({...payload,id,items})]);};
  await t.test('new manual service cost is saved and included in totals',async()=>{assert.equal(await cost(),600);});
  await t.test('editing manual cost changes total without changing sale price',async()=>{await update([{...line,manual_cost_unit:150}]);assert.equal(await cost(),300);assert.equal(Number((await db.query('select total_sale from public.orders where id=$1',[id])).rows[0].total_sale),2000);});
  await t.test('staff cannot submit costs and ordinary staff edit preserves saved cost',async()=>{await db.exec("set test.role='staff'");await assert.rejects(update([line]),/manual cost requires admin/);const {manual_cost_unit,...ordinary}=line;await update([ordinary]);assert.equal(await cost(),300);await db.exec("set test.role='admin'");});
  await t.test('negative, NaN and infinite cost cannot be saved',async()=>{for(const bad of [-1,'NaN','Infinity'])await assert.rejects(update([{...line,manual_cost_unit:bad}]),/invalid manual cost/);assert.equal(await cost(),300);});
  await t.test('procurement accepts provisional cost then protects authoritative supplier quote',async()=>{
   const p={...line,line_key:'part',fulfillment_type:'procurement',manual_cost_unit:400};await update([p]);assert.equal(await cost(),800);
   await db.query("select public.backoffice_sync_procurement_cost($1,'part',500,'廠商A',null,current_date)",[id]);
   await assert.rejects(update([p]),/廠商報價帶入/);
   const {manual_cost_unit,...noOverride}=p;await update([noOverride]);assert.equal(await cost(),1000);
   const extra=(await db.query('select extra from public.order_items where order_id=$1',[id])).rows[0].extra;assert.equal(extra.procurement_cost_locked,true);assert.equal('manual_cost_unit' in extra,false);
  });
  await t.test('install again does not change existing orders',async()=>{const before=JSON.stringify((await db.query('select * from public.orders')).rows);await db.exec(read('supabase-order-manual-cost.sql'));assert.equal(JSON.stringify((await db.query('select * from public.orders')).rows),before);});
 }finally{await db.close();}
});
