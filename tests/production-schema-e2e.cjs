// Schema-only fixture exported read-only from production main 2e7d576 on 2026-11-07 (Taipei).
// No business rows, auth users, credentials or production writes are used.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
const {PGlite}=require('@electric-sql/pglite'),{pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
test('production schema in isolation: procurement receipt, stale retry, serial uniqueness, completion, cost and anonymous denial', {timeout:60000}, async()=>{
const s=JSON.parse(zlib.gunzipSync(fs.readFileSync(require('node:path').join(__dirname,'fixtures/production-schema-20261107.json.gz'))));
const db=new PGlite({extensions:{pgcrypto}});
try{
await db.exec(`create extension if not exists pgcrypto;set check_function_bodies=off;create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'anon')$$;grant usage on schema public,auth to anon,authenticated,service_role;grant execute on all functions in schema auth to anon,authenticated,service_role;`);
for(const k of ['tables','constraints','functions','views','indexes','triggers','rls','policies','grants']){let i=0;for(const q of (k==='constraints'?s[k].slice().sort((a,b)=>Number(a.includes('FOREIGN KEY'))-Number(b.includes('FOREIGN KEY'))):s[k])||[]){try{await db.exec(q);i++;}catch(e){console.log(k,i,e.message,q.slice(0,140));throw e;}}}
await db.exec('revoke execute on all functions in schema public from public,anon,authenticated;');for(const q of s.function_grants)await db.exec(q);await db.exec('begin');
const uid='33333333-3333-4333-8333-333333333333';await db.exec(`insert into auth.users(id) values('${uid}');insert into inventory_inbound_settings(id,tracking_start_date) values('default','2026-01-01');insert into profiles(id,username,role,enabled) values('${uid}','e2e-admin3','admin',true);`);
await db.exec(`set role authenticated;set request.jwt.claim.sub='${uid}';set request.jwt.claim.role='authenticated';`);
const denies=async(fn,pattern)=>{await db.exec('savepoint rejected');await assert.rejects(fn,pattern);await db.exec('rollback to savepoint rejected');};
const rpc=async(name,args)=>{const marks=args.map((_,i)=>'$'+(i+1)).join(',');return (await db.query('select public.'+name+'('+marks+') as r',args)).rows[0].r;};
const lines=[{line_key:'cpu',fulfillment_type:'procurement',name:'E2E CPU',category:'處理器',qty:1,unit_price:6000}];
const order=await rpc('backoffice_create_order_v2',['E2E-003','TEST','','','整機',0,0,'cash','confirmed',JSON.stringify(lines)]);const id=order.id;
const item={id:'e2e-line2',category:'處理器',requestText:'E2E CPU',quantity:1,sourceSalesOrderId:id,sourceSalesOrderLineKey:'cpu',selectedSpec:'E2E CPU',selectedVendor:'E2E Vendor',selectedUnitPrice:4000,procurementStatus:'pending'};
let po={id:'e2e-po2',order_no:'E2E-PO',status:'ordered',created_at:new Date().toISOString(),items_json:[item],data_json:{}};
let saved=await rpc('backoffice_purchase_operation',[JSON.stringify(po),null,JSON.stringify({type:'save'})]);po=saved.purchase_order;
const stale=structuredClone(po);const receive=await rpc('backoffice_purchase_operation',[JSON.stringify(po),po.updated_at,JSON.stringify({type:'receive',purchase_item_id:item.id,destination:'customer',received_at:'2026-11-07'})]);po=receive.purchase_order;
await denies(()=>rpc('backoffice_purchase_operation',[JSON.stringify(stale),stale.updated_at,JSON.stringify({type:'receive',purchase_item_id:item.id,destination:'customer',received_at:'2026-11-07'})]));
const inv=po.items_json[0].receiptInventoryItemId;await rpc('backoffice_register_receipt_serials',[inv,po.id,item.id,id,'cpu','2026-11-07',JSON.stringify(['E2E-SN-002']),'']);
await denies(()=>rpc('backoffice_register_receipt_serials',[inv,po.id,item.id,id,'cpu','2026-11-07',JSON.stringify(['e2e-sn-002']),'']),/存在|duplicate/i);

const finalLines=[{...lines[0],fulfillment_type:'inventory',item_id:inv}];
const version=(await db.query('select updated_at::text version from orders where id=$1',[id])).rows[0].version;
const done=await rpc('backoffice_update_order_checked',[version,JSON.stringify({id,order_no:'E2E-003',customer_name:'TEST',sales_type:'整機',shipping_income:0,discount:0,payment_method:'cash',status:'completed',items:finalLines,payment_status:'paid',received_amount:6000,payment_date:'2026-11-07',delivery_status:'delivered',delivered_at:'2026-11-07'})]);assert.equal(done.status,'completed');
await db.exec('reset role');const counts=await db.query('select (select count(*) from inventory_ledger)::int ledger,(select qty_on_hand from inventory_items where id=$1) qty,(select cogs_total from order_costs where order_id=$2) cost',[inv,id]);assert.equal(Number(counts.rows[0].qty),0);assert.equal(Number(counts.rows[0].cost),4000);assert.equal(Number(counts.rows[0].ledger),2);
await db.exec('set role authenticated');
const apPayload={vendor_name:'E2E Vendor',settlement_type_snapshot:'CUSTOM',period_start:'2026-11-01',period_end:'2026-11-30',purchase_order_ids:[po.id]};
const ap1=await rpc('backoffice_create_vendor_reconciliation',[JSON.stringify(apPayload)]);
assert.equal(Number(ap1.system_amount),4000);
await rpc('backoffice_void_vendor_reconciliation',[ap1.id]);
const ap2=await rpc('backoffice_create_vendor_reconciliation',[JSON.stringify(apPayload)]);
assert.notEqual(ap1.id,ap2.id);
await rpc('backoffice_update_vendor_reconciliation',[JSON.stringify({id:ap2.id,status:'CONFIRMED',vendor_claimed_amount:4000})]);
const paid=await rpc('backoffice_confirm_vendor_payment',[ap2.id]);assert.equal(paid.status,'PAID');
const paidAgain=await rpc('backoffice_confirm_vendor_payment',[ap2.id]);assert.equal(paidAgain.idempotent,true);
await denies(()=>rpc('backoffice_create_vendor_reconciliation',[JSON.stringify(apPayload)]));
assert.equal(Number((await db.query('select count(*) n from expenses')).rows[0].n),1);
await db.exec('set request.jwt.claim.sub=\'44444444-4444-4444-8444-444444444444\';');
await denies(()=>rpc('backoffice_create_order_v2',['UNAUTHORIZED','TEST','','','整機',0,0,'cash','confirmed',JSON.stringify(lines)]),/permission denied/);
await db.exec('set role anon;set request.jwt.claim.sub=\'\';set request.jwt.claim.role=\'anon\';');await denies(()=>db.query('select * from orders'),/permission denied/);await denies(()=>db.query('select * from builder_submissions'),/permission denied/);await db.query("insert into builder_submissions(build_no,payload,status) values('E2E-PUBLIC',$1,'new')",[JSON.stringify({items:[{name:'E2E',qty:1,unit_price:6000}],total:6000,website:''})]);await denies(()=>db.query("insert into builder_submissions(build_no,payload,status) values('E2E-FORGED','{}','converted')"),/row-level security/);await denies(()=>rpc('backoffice_create_order_v2',['BAD','TEST','','','整機',0,0,'cash','confirmed',JSON.stringify(lines)]),/permission denied/);

}finally{await db.exec('rollback');await db.close();}
});
