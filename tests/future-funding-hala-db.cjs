const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8').replace(/\r\n/g,'\n');
const fn=(sql,name)=>{const start=sql.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'(');assert.ok(start>=0,name);return sql.slice(start,sql.indexOf('$$;',start)+3);};
test('future funding is HALA while existing BOSS ownership is preserved',async t=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create function auth.uid() returns uuid language sql as $$select null::uuid$$;
   create function public.dk_require_backoffice() returns text language sql as $$select current_setting('test.role',true)$$;
   create function public.is_admin() returns boolean language sql as $$select current_setting('test.role',true)='admin'$$;
   create function public.dk_taiwan_today() returns date language sql as $$select current_date$$;
   set test.role='admin';`);
  const base=read('supabase-stage7-v2-normalization.sql');
  for(const name of ['inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs','orders','order_costs','order_items','order_item_costs']){
   const start=base.indexOf('CREATE TABLE IF NOT EXISTS public.'+name+' (');await db.exec(base.slice(start,base.indexOf('\n);',start)+3));
  }
  await db.exec(`alter table public.inventory_ledger add movement_type text,add business_date date,add created_by uuid,add cost_status text;
   insert into public.inventory_items(id,name,qty_on_hand) values('old-boss','舊庫存',2);
   insert into public.inventory_costs(item_id,cost_unit) values('old-boss',100);`);
  await db.exec(read('supabase-inventory-funding-boss-hala.sql'));
  await db.exec(fn(read('supabase-stage26-order-integrity.sql'),'inventory_ledger_before_insert'));
  await db.exec(`create trigger trg_inventory_ledger_before_insert before insert on public.inventory_ledger for each row execute function public.inventory_ledger_before_insert();`);
  const before=(await db.query('select * from public.inventory_funding_lots')).rows;
  await db.exec(read('supabase-future-funding-hala.sql'));
  const receive=async(key,order=null,line=null,qty=2,cost=300)=> (await db.query('select public.backoffice_receive_purchase_item($1,$2,$3,$4,null,$5,$6,$7,$8,$9,current_date,null) result',[order,line,'po-'+key,key,'商品-'+key,'CPU',qty,cost,'廠商'])).rows[0].result;
  const lots=async id=>(await db.query('select owner,qty_received,qty_remaining,unit_cost,source_key from public.inventory_funding_lots where item_id=$1 order by source_key',[id])).rows;
  const move=async(id,item,qty,ref)=>db.query("insert into public.inventory_ledger(id,item_id,type,qty,ref_type,ref_id) values($1,$2,$3,$4,'ORDER',$5)",[id,item,qty>0?'IN':'OUT',qty,ref]);
  await t.test('installation leaves all existing BOSS lots unchanged',async()=>assert.deepEqual((await db.query('select * from public.inventory_funding_lots')).rows,before));
  await t.test('unlinked purchase receipt creates one HALA lot at actual cost',async()=>{
   const r=await receive('stock');const rows=await lots(r.item_id);assert.equal(rows.length,1);assert.equal(rows[0].owner,'hala');assert.equal(Number(rows[0].qty_remaining),2);assert.equal(Number(rows[0].unit_cost),300);
   const retry=await receive('stock');assert.equal(retry.already_received,true);assert.equal((await lots(r.item_id)).length,1);
  });
  await t.test('confirmed manual procurement funds HALA before automatic reservation; return restores HALA once',async()=>{
   await db.exec(`insert into public.orders(id,order_no,status) values('order-new','NEW','confirmed');
    insert into public.order_items(id,order_id,name,qty,extra) values('line-new','order-new','新叫貨',2,'{"line_key":"part","fulfillment_type":"procurement"}');`);
   const r=await receive('customer','order-new','part');assert.equal(r.reserved_for_order,true);
   const rows=await lots(r.item_id);assert.equal(rows.length,1);assert.equal(rows[0].owner,'hala');assert.equal(Number(rows[0].qty_remaining),0);
   const allocations=(await db.query('select * from public.inventory_funding_allocations where outbound_ledger_id in(select id from public.inventory_ledger where item_id=$1)',[r.item_id])).rows;
   assert.equal(allocations.length,1);assert.equal(allocations[0].owner,'hala');assert.equal(Number(allocations[0].unit_cost),300);
   await receive('customer','order-new','part');assert.equal((await lots(r.item_id)).length,1);
   await move('return-new',r.item_id,2,'order-new');assert.equal(Number((await lots(r.item_id))[0].qty_remaining),2);
   await move('return-retry',r.item_id,2,'order-new');assert.equal(Number((await lots(r.item_id))[0].qty_remaining),2);
  });
  await t.test('negotiating procurement remains HALA stock until subsequent reservation',async()=>{
   await db.exec(`insert into public.orders(id,order_no,status) values('order-talk','TALK','negotiating');
    insert into public.order_items(id,order_id,name,qty,extra) values('line-talk','order-talk','洽談叫貨',1,'{"line_key":"part"}');`);
   const r=await receive('talk','order-talk','part',1);assert.equal(r.reserved_for_order,false);assert.equal(Number((await lots(r.item_id))[0].qty_remaining),1);
   await move('reserve-talk',r.item_id,-1,'order-talk');assert.equal((await db.query("select owner from public.inventory_funding_allocations where outbound_ledger_id='reserve-talk'")).rows[0].owner,'hala');
  });
  await t.test('missing funding fallback now HALA; existing BOSS lots and returns retain BOSS',async()=>{
   await db.exec(`insert into public.inventory_items(id,name,qty_on_hand) values('gap','缺口',1);insert into public.inventory_costs(item_id,cost_unit) values('gap',80);`);
   await move('gap-sale','gap',-1,'gap-order');assert.equal((await db.query("select owner from public.inventory_funding_allocations where outbound_ledger_id='gap-sale'")).rows[0].owner,'hala');
   await move('old-sale','old-boss',-1,'old-order');assert.equal((await db.query("select owner from public.inventory_funding_allocations where outbound_ledger_id='old-sale'")).rows[0].owner,'boss');
   await move('old-return','old-boss',1,'old-order');assert.equal(Number((await lots('old-boss'))[0].qty_remaining),2);
  });
  await t.test('default manual inbound HALA and explicit BOSS remain supported',async()=>{
   for(const [id,owner] of [['in-default','hala'],['in-explicit','boss']]){
    await db.query("insert into public.inventory_ledger(id,item_id,type,qty) values($1,'old-boss','IN',1)",[id]);
    if(owner==='hala')await db.query('select public.backoffice_assign_inbound_funding($1)',[id]);
    else await db.query('select public.backoffice_assign_inbound_funding($1,$2)',[id,owner]);
    assert.equal((await db.query('select owner from public.inventory_funding_lots where source_ledger_id=$1',[id])).rows[0].owner,owner);
   }
  });
  await t.test('mixed inventory still consumes existing BOSS principal before new HALA',async()=>{
   await move('mixed-sale','old-boss',-4,'mixed-order');
   const rows=(await db.query("select owner,sum(qty) qty from public.inventory_funding_allocations where outbound_ledger_id='mixed-sale' group by owner order by owner")).rows;
   assert.deepEqual(rows.map(x=>[x.owner,Number(x.qty)]),[['boss',3],['hala',1]]);
  });
  await t.test('late receipt failure rolls back inbound and funding together; nonadmin blocked',async()=>{
   const snapshot=async()=>JSON.stringify((await db.query("select (select count(*) from public.inventory_ledger) ledger,(select count(*) from public.inventory_funding_lots) lots,(select count(*) from public.inventory_items) items")).rows);
   await db.exec(`create function public.test_fail_receipt() returns trigger language plpgsql as $$begin if new.extra->>'receipt_purchase_item_id'='fail' then raise exception 'test late failure';end if;return new;end$$;
    create trigger test_fail_receipt before update on public.order_items for each row execute function public.test_fail_receipt();`);
   const before=await snapshot();await assert.rejects(receive('fail','order-talk','part'),/test late failure/);assert.equal(await snapshot(),before);
   await db.exec("set test.role='staff'");await assert.rejects(receive('staff'),/permission denied/);assert.equal(await snapshot(),before);await db.exec("set test.role='admin'");
  });
  await t.test('reinstallation does not change any records or expose internal functions',async()=>{
   const before=JSON.stringify((await db.query('select * from public.inventory_funding_lots order by id')).rows);
   await db.exec(read('supabase-future-funding-hala.sql'));assert.equal(JSON.stringify((await db.query('select * from public.inventory_funding_lots order by id')).rows),before);
   for(const sig of ['public.dk_apply_inventory_funding_movement()','public.backoffice_receive_purchase_item(text,text,text,text,text,text,text,numeric,numeric,text,date,text)']){
    assert.equal((await db.query("select has_function_privilege('authenticated',$1,'EXECUTE') allowed",[sig])).rows[0].allowed,false);
   }
  });
 }finally{await db.close();}
});
