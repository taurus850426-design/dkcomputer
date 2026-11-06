// Schema-only fixture exported read-only from production main 2e7d576 on 2026-11-07 (Taipei).
// No business rows, auth users, credentials or production writes are used.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
const {PGlite}=require('@electric-sql/pglite'),{pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
test('scan receipt atomicity, assembly model checks, shipment guards and unchanged stock', {timeout:60000}, async()=>{
const s=JSON.parse(zlib.gunzipSync(fs.readFileSync(require('node:path').join(__dirname,'fixtures/production-schema-20261107.json.gz'))));
const db=new PGlite({extensions:{pgcrypto}});
try{
await db.exec(`create extension if not exists pgcrypto;set check_function_bodies=off;create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'anon')$$;grant usage on schema public,auth to anon,authenticated,service_role;grant execute on all functions in schema auth to anon,authenticated,service_role;`);
for(const k of ['tables','constraints','functions','views','indexes','triggers','rls','policies','grants']){let i=0;for(const q of (k==='constraints'?s[k].slice().sort((a,b)=>Number(a.includes('FOREIGN KEY'))-Number(b.includes('FOREIGN KEY'))):s[k])||[]){try{await db.exec(q);i++;}catch(e){console.log(k,i,e.message,q.slice(0,140));throw e;}}}
await db.exec(fs.readFileSync('supabase-order-scan.sql','utf8'));
await db.exec('revoke execute on all functions in schema public from public,anon,authenticated;');for(const q of s.function_grants)await db.exec(q);await db.exec('grant execute on function public.backoffice_order_scan(text,text,text,text,text) to authenticated');await db.exec('begin');
const uid='33333333-3333-4333-8333-333333333333';await db.exec(`insert into auth.users(id) values('${uid}');insert into inventory_inbound_settings(id,tracking_start_date) values('default','2026-01-01');insert into profiles(id,username,role,enabled) values('${uid}','e2e-admin3','admin',true);`);
await db.exec(`set role authenticated;set request.jwt.claim.sub='${uid}';set request.jwt.claim.role='authenticated';`);
const denies=async(fn,pattern)=>{await db.exec('savepoint rejected');await assert.rejects(fn,pattern);await db.exec('rollback to savepoint rejected');};
const rpc=async(name,args)=>{const marks=args.map((_,i)=>'$'+(i+1)).join(',');return (await db.query('select public.'+name+'('+marks+') as r',args)).rows[0].r;};

const readOwner=async(q,args=[])=>{await db.exec('reset role');try{return await db.query(q,args);}finally{await db.exec('set role authenticated');}};
const create=async(no,lines)=>(await rpc('backoffice_create_order_checked',[JSON.stringify({order_no:no,status:'confirmed',payment_method:'cash',items:lines})])).id;
const line={line_key:'cpu',fulfillment_type:'procurement',name:'CPU TEST',category:'處理器',qty:1,unit_price:6000};
const id=await create('SCAN-TEST-1',[line]);
const item={id:'p1',category:'處理器',requestText:'CPU TEST',quantity:1,sourceSalesOrderId:id,sourceSalesOrderLineKey:'cpu',selectedSpec:'CPU TEST',selectedVendor:'Vendor',selectedUnitPrice:4000,procurementStatus:'pending'};
const save=await rpc('backoffice_purchase_operation',[JSON.stringify({id:'scan-po',order_no:'SCAN-PO',status:'ordered',created_at:'2026-11-07',items_json:[item],data_json:{}}),null,JSON.stringify({type:'save'})]);
let po=save.purchase_order;
const receive=await rpc('backoffice_purchase_operation',[JSON.stringify(po),po.updated_at,JSON.stringify({type:'receive',purchase_item_id:'p1',destination:'customer',received_at:'2026-11-07',serial_numbers:['CPU-SN-1']})]);
po=receive.purchase_order;assert.deepEqual(po.items_json[0].serialNumbers,['CPU-SN-1']);
assert.equal((await readOwner("select count(*) n from inventory_serials where serial_no='CPU-SN-1'")).rows[0].n,1);
let state=await rpc('backoffice_order_scan',[id,'inspect','','',null]);
const scan=async(action,code='',key='cpu')=>{state=await rpc('backoffice_order_scan',[id,action,code,key,state.updated_at]);return state;};
await denies(()=>scan('test'),/尚未掃齊/);
await denies(()=>scan('bind','UNKNOWN'),/尚未建檔/);
await scan('bind','cpu-sn-1');assert.equal(state.serials[0].checked,true);
await scan('bind','CPU-SN-1');assert.equal(state.serials.length,1);
await scan('test');assert.equal(state.scan_test_current,true);
await denies(()=>scan('ship','WRONG'),/編號不符/);
await denies(()=>scan('ship','SCAN-TEST-1'),/收足/);
await scan('unbind','CPU-SN-1');assert.equal(state.scan_test_current,false);
await scan('bind','CPU-SN-1');
await denies(()=>rpc('backoffice_set_order_operations_checked',[state.updated_at,JSON.stringify({id,payment_status:'paid',received_amount:6000,payment_date:'2026-11-07',delivery_status:'delivered',delivered_at:'2026-11-07'})]),/掃碼核對/);
await scan('test');
const before=await readOwner('select qty_on_hand from inventory_items where id=$1',[receive.operation.item_id]);
await rpc('backoffice_set_order_operations_checked',[state.updated_at,JSON.stringify({id,payment_status:'paid',received_amount:6000,payment_date:'2026-11-07',delivery_status:'pending'})]);state=await rpc('backoffice_order_scan',[id,'inspect','','',null]);
await scan('ship','SCAN-TEST-1');assert.equal(state.delivery_status,'delivered');assert.equal(state.serials[0].status,'sold');
assert.deepEqual((await readOwner('select qty_on_hand from inventory_items where id=$1',[receive.operation.item_id])).rows,before.rows);
await denies(()=>scan('ship','SCAN-TEST-1'),/已交付/);
// Duplicate serial rolls back the ENTIRE second receipt, inventory and PO status.
const id2=await create('SCAN-TEST-2',[line]);const item2={...item,id:'p2',sourceSalesOrderId:id2};
let po2=(await rpc('backoffice_purchase_operation',[JSON.stringify({id:'scan-po2',order_no:'SCAN-PO2',status:'ordered',created_at:'2026-11-07',items_json:[item2],data_json:{}}),null,JSON.stringify({type:'save'})])).purchase_order;
const ledgerBefore=(await readOwner('select count(*) n from inventory_ledger')).rows;
await denies(()=>rpc('backoffice_purchase_operation',[JSON.stringify(po2),po2.updated_at,JSON.stringify({type:'receive',purchase_item_id:'p2',destination:'customer',received_at:'2026-11-07',serial_numbers:['cpu-sn-1']})]),/duplicate/i);
assert.deepEqual((await readOwner('select count(*) n from inventory_ledger')).rows,ledgerBefore);
assert.equal((await readOwner("select status from purchase_orders where id='scan-po2'")).rows[0].status,'ordered');
await db.exec('reset role');await db.exec(fs.readFileSync('supabase-order-scan.sql','utf8'));await db.exec('begin;set role anon');await denies(()=>rpc('backoffice_order_scan',[id,'inspect','','',null]),/permission denied/);
}finally{await db.exec('rollback');await db.close();}
});
