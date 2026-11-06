const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite'),{pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261106233806_shop_core_order_bridge.sql'),'utf8');
test('WEB bridge: reviewed conversion, trusted payment, idempotent order, one stock/accounting writer, refund and legacy isolation',{timeout:60000},async()=>{
 const db=new PGlite({extensions:{pgcrypto}}),s=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,'fixtures/production-schema-20261107.json.gz'))));
 const uid='33333333-3333-4333-8333-333333333333',web='11111111-1111-4111-8111-111111111111';
 try{
  await db.exec(`create extension if not exists pgcrypto;set check_function_bodies=off;create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'anon')$$;grant usage on schema public,auth to anon,authenticated,service_role;grant execute on all functions in schema auth to anon,authenticated,service_role;`);
  for(const k of ['tables','constraints','functions','views','indexes','triggers','rls','policies','grants'])for(const q of (k==='constraints'?s[k].slice().sort((a,b)=>Number(a.includes('FOREIGN KEY'))-Number(b.includes('FOREIGN KEY'))):s[k])||[])await db.exec(q);
  await db.exec('revoke execute on all functions in schema public from public,anon,authenticated;');for(const q of s.function_grants)await db.exec(q);
  for(const file of ['20261107013244_scan_order_workflow.sql','20261107022129_scan_lifecycle_integrity.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations',file),'utf8'));
  await db.exec(migration);await db.exec(migration);
  await db.exec(`insert into auth.users(id) values('${uid}');insert into profiles(id,username,role,enabled) values('${uid}','bridge-admin','admin',true);insert into inventory_inbound_settings(id,tracking_start_date) values('default','2026-01-01');`);
  await db.query("insert into inventory(id,name,category,price,qty,stock_status,note,photos) values('WEB-PC','WEB display PC','整機',6000,2,'現貨','','[]')");
  await db.query("insert into inventory_items(id,sku,name,category,qty_on_hand) values('CPU-A','CPU-A','Actual CPU','處理器',2)");
  await db.query("insert into inventory_costs(item_id,cost_unit) values('CPU-A',4000)");
  await db.query(`insert into shop_orders(id,request_key,token_hash,request_hash,ip_hash,customer,items,subtotal,shipping_fee,payment,environment,status,hold_until) values($1,gen_random_uuid(),repeat('a',64),'h','i',$2,$3,6000,100,'transfer','live','awaiting_payment',now()+interval '1 day')`,[web,JSON.stringify({name:'Synthetic Buyer',phone:'0912345678',fulfillment:'delivery',address:'Synthetic Address'}),JSON.stringify([{id:'WEB-PC',name:'WEB display PC',qty:1,unit_price:6000}])]);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${uid}';set request.jwt.claim.role='authenticated';`);
  const rpc=async(name,args)=>(await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') r',args)).rows[0].r;
  const scalar=async(sql,args=[])=>{const role=(await db.query('select current_user r')).rows[0].r;await db.exec('reset role');try{return (await db.query(sql,args)).rows[0];}finally{await db.exec('set role '+role);}};
  const version=async()=> (await scalar('select updated_at::text v from shop_orders where id=$1',[web])).v;
  const payload={shop_reviewed:true,order_no:'BRIDGE-001',customer_name:'forged',sales_type:'整機',shipping_income:100,discount:0,status:'confirmed',payment_status:'paid',received_amount:6100,delivery_status:'delivered',items:[{line_key:'cpu',fulfillment_type:'inventory',item_id:'CPU-A',category:'處理器',name:'Actual CPU',qty:1,unit_price:6000}]};
  const convert=(p=payload,v)=>rpc('backoffice_convert_shop_order',[web,v,JSON.stringify(p)]);
  const reject=async(fn,re)=>{await assert.rejects(fn,re);}; // each RPC is a standalone transaction: test atomic rollback
  await reject(()=>convert({...payload,items:[{...payload.items[0],fulfillment_type:'service'}]},'2026-01-01'),/更新/);
  await reject(async()=>convert({...payload,items:[{...payload.items[0],fulfillment_type:'service'}]},await version()),/服務/);
  await reject(async()=>convert({...payload,shipping_income:999},await version()),/合計/);
  await reject(async()=>convert({...payload,status:'completed'},await version()),/已確認/);
  await reject(async()=>convert({...payload,shop_reviewed:false},await version()),/先核對/);
  await db.exec('reset role');await db.query("insert into orders(id,order_no,customer_name,status,extra) values('MANUAL','MANUAL','Synthetic','negotiating',jsonb_build_object('quote_note',(select order_no from shop_orders where id=$1)))",[web]);await db.exec('set role authenticated');
  await reject(async()=>convert(payload,await version()),/已有記錄/);await db.exec("reset role;delete from orders where id='MANUAL';set role authenticated");
  assert.equal(Number((await scalar('select count(*) n from orders')).n),0);
  const v=await version();const created=await convert(payload,v),id=created.id;
  assert.ok(id);const core=await scalar('select * from orders where id=$1',[id]);assert.equal(core.customer_name,'Synthetic Buyer');assert.equal(core.extra.payment_status,'unpaid');assert.equal(core.extra.delivery_status,'pending');assert.equal(core.extra.shop_order_id,web);
  assert.equal((await scalar('select hold_until from shop_orders where id=$1',[web])).hold_until,null);
  assert.equal(Number((await scalar('select qty from inventory where id=\'WEB-PC\'')).qty),2);
  const retry=await convert({...payload,order_no:'FORGED-DUPLICATE'},v);assert.equal(retry.id,id);assert.equal(retry.shop_already_linked,true);assert.equal(Number((await scalar('select count(*) n from orders')).n),1);
  // Even service-only legacy APIs cannot independently mark a linked order as paid/cancelled/fulfilled.
  await db.exec('set role service_role');
  await reject(async()=>rpc('shop_manual_payment',[web,await version(),'already paid']),/後台訂單/);
  await reject(async()=>rpc('shop_cancel',[web,await version()]),/後台訂單/);
  await db.exec('set role authenticated');
  const update=async(changes={})=>{const old=await scalar('select updated_at::text v from orders where id=$1',[id]);return rpc('backoffice_update_order_checked',[old.v,JSON.stringify({...payload,id,customer_name:'Synthetic Buyer',payment_status:'paid',received_amount:6100,payment_date:'2026-11-07',delivery_status:'delivered',delivered_at:'2026-11-07',...changes})]);};
  await reject(()=>update({items:[{...payload.items[0],unit_price:7000}],received_amount:7100}),/原單一致/);
  assert.equal(Number((await scalar('select total_sale from orders where id=$1',[id])).total_sale),6000);
  await update({status:'confirmed',delivery_status:'pending',delivered_at:null});
  assert.equal((await scalar('select status from shop_orders where id=$1',[web])).status,'paid');
  await update({status:'completed'});
  const tally=await scalar("select (select qty from inventory where id='WEB-PC') web_qty,(select qty_on_hand from inventory_items where id='CPU-A') core_qty,(select cogs_total from order_costs where order_id=$1) cost,(select count(*) from shop_order_links where catalogue_deducted) deducted",[id]);
  assert.equal(Number(tally.web_qty),1);assert.equal(Number(tally.core_qty),1);assert.equal(Number(tally.cost),4000);assert.equal(Number(tally.deducted),1);
  assert.equal((await scalar('select status from shop_orders where id=$1',[web])).status,'fulfilled');
  await update({status:'completed'});assert.equal(Number((await scalar("select qty from inventory where id='WEB-PC'")).qty),1);
  await db.exec('set role service_role');await reject(async()=>rpc('shop_fulfill',[web,await version()]),/only verified/);await db.exec('set role authenticated');
  await update({status:'refunded'});assert.equal((await scalar('select status from shop_orders where id=$1',[web])).status,'cancelled');assert.equal(Number((await scalar("select qty from inventory where id='WEB-PC'")).qty),1);assert.equal(Number((await scalar("select qty_on_hand from inventory_items where id='CPU-A'")).qty_on_hand),2);
  // Verified source payment is copied exactly once; caller cannot fake paid or fulfillment.
  await db.exec('reset role');await db.query(`insert into shop_orders(id,request_key,token_hash,request_hash,ip_hash,customer,items,subtotal,shipping_fee,payment,environment,status,paid_at,manual_reference) select '22222222-2222-4222-8222-222222222222',gen_random_uuid(),token_hash,request_hash,ip_hash,customer,items,subtotal,shipping_fee,payment,environment,'paid',now(),'BANK-123' from shop_orders where id=$1`,[web]);await db.exec('set role authenticated');
  const other='22222222-2222-4222-8222-222222222222',otherV=(await scalar('select updated_at::text v from shop_orders where id=$1',[other])).v;
  const paid=await rpc('backoffice_convert_shop_order',[other,otherV,JSON.stringify({...payload,order_no:'BRIDGE-002',payment_status:'unpaid',received_amount:0})]);assert.equal((await scalar('select extra from orders where id=$1',[paid.id])).extra.received_amount,6100);
  // Completion is atomic when the public display stock changed: core stock/accounting must not commit.
  await db.exec('reset role');await db.exec("update inventory set qty=0 where id='WEB-PC'");await db.exec('set role authenticated');
  const paidV=(await scalar('select updated_at::text v from orders where id=$1',[paid.id])).v;
  const before=(await scalar("select qty_on_hand from inventory_items where id='CPU-A'")).qty_on_hand;
  await reject(()=>rpc('backoffice_update_order_checked',[paidV,JSON.stringify({...payload,id:paid.id,order_no:'BRIDGE-002',status:'completed',payment_status:'paid',received_amount:6100,payment_date:'2026-11-07',delivery_status:'delivered',delivered_at:'2026-11-07'})]),/上架數量不足/);
  assert.equal((await scalar("select qty_on_hand from inventory_items where id='CPU-A'")).qty_on_hand,before);
  assert.equal((await scalar('select status from orders where id=$1',[paid.id])).status,'confirmed');
  // Paid money cannot disappear through a core edit.
  await reject(()=>rpc('backoffice_update_order_checked',[paidV,JSON.stringify({...payload,id:paid.id,order_no:'BRIDGE-002',payment_status:'unpaid',received_amount:0,delivery_status:'pending'})]),/已核實收款/);
  // Existing unlinked orders still use their original web-only fulfillment and create no core orders.
  await db.exec('reset role');await db.exec("update inventory set qty=2 where id='WEB-PC'");
  const legacy='44444444-4444-4444-8444-444444444444';
  await db.query(`insert into shop_orders(id,request_key,token_hash,request_hash,ip_hash,customer,items,subtotal,shipping_fee,payment,environment,status,paid_at) select $2,gen_random_uuid(),token_hash,request_hash,ip_hash,customer,items,subtotal,shipping_fee,payment,environment,'paid',now() from shop_orders where id=$1`,[web,legacy]);
  await db.exec('set role service_role');await rpc('shop_fulfill',[legacy,(await scalar('select updated_at::text v from shop_orders where id=$1',[legacy])).v]);await db.exec('set role authenticated');
  assert.equal(Number((await scalar("select qty from inventory where id='WEB-PC'")).qty),1);assert.equal(Number((await scalar('select count(*) n from orders')).n),2);
  // RLS and RPC authorization: staff cannot convert/read links; anonymous denied.
  await db.exec('reset role');await db.query('update profiles set role=\'staff\' where id=$1',[uid]);await db.exec('set role authenticated');assert.equal((await db.query('select * from shop_order_links')).rows.length,0);await reject(()=>convert(payload,v),/permission denied/);
  await db.exec("set role anon;set request.jwt.claim.sub='';");await reject(()=>convert(payload,v),/permission denied/);await reject(()=>db.query('select * from shop_order_links'),/permission denied/);
 }finally{await db.close();}
});
