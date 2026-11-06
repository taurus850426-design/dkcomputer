// Schema-only fixture exported read-only from production main 2e7d576 on 2026-11-07 (Taipei).
// No business rows, auth users, credentials or production writes are used.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
const {PGlite}=require('@electric-sql/pglite'),{pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
test('current workflow audit: receipt destination, non-scanned completion, provenance, assembly, refund and accounting', {timeout:60000}, async()=>{
const s=JSON.parse(zlib.gunzipSync(fs.readFileSync(require('node:path').join(__dirname,'fixtures/production-schema-20261107.json.gz'))));
const db=new PGlite({extensions:{pgcrypto}});
try{
await db.exec(`create extension if not exists pgcrypto;set check_function_bodies=off;create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'anon')$$;grant usage on schema public,auth to anon,authenticated,service_role;grant execute on all functions in schema auth to anon,authenticated,service_role;`);
for(const k of ['tables','constraints','functions','views','indexes','triggers','rls','policies','grants']){let i=0;for(const q of (k==='constraints'?s[k].slice().sort((a,b)=>Number(a.includes('FOREIGN KEY'))-Number(b.includes('FOREIGN KEY'))):s[k])||[]){try{await db.exec(q);i++;}catch(e){console.log(k,i,e.message,q.slice(0,140));throw e;}}}
await db.exec('revoke execute on all functions in schema public from public,anon,authenticated;');for(const q of s.function_grants)await db.exec(q);await db.exec(fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20261107013244_scan_order_workflow.sql'),'utf8'));await db.exec(fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20261107013244_scan_order_workflow.sql'),'utf8'));await db.exec(fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20261107022129_scan_lifecycle_integrity.sql'),'utf8'));await db.exec(fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20261107022129_scan_lifecycle_integrity.sql'),'utf8'));await db.exec('begin');
const uid='33333333-3333-4333-8333-333333333333';await db.exec(`insert into auth.users(id) values('${uid}');insert into inventory_inbound_settings(id,tracking_start_date) values('default','2026-01-01');insert into profiles(id,username,role,enabled) values('${uid}','e2e-admin3','admin',true);`);
await db.exec(`set role authenticated;set request.jwt.claim.sub='${uid}';set request.jwt.claim.role='authenticated';`);
const denies=async(fn,pattern)=>{await db.exec('savepoint rejected');await assert.rejects(fn,pattern);await db.exec('rollback to savepoint rejected');};
const rpc=async(name,args)=>{const marks=args.map((_,i)=>'$'+(i+1)).join(',');return (await db.query('select public.'+name+'('+marks+') as r',args)).rows[0].r;};
const lines=[{line_key:'cpu',fulfillment_type:'procurement',name:'E2E CPU',category:'處理器',qty:1,unit_price:6000}];
const order=await rpc('backoffice_create_order_v2',['E2E-003','TEST','','','整機',0,0,'cash','confirmed',JSON.stringify(lines)]);const id=order.id;
const item={id:'e2e-line2',category:'處理器',requestText:'E2E CPU',quantity:1,sourceSalesOrderId:id,sourceSalesOrderLineKey:'cpu',selectedSpec:'E2E CPU',selectedVendor:'E2E Vendor',selectedUnitPrice:4000,procurementStatus:'pending'};
let po={id:'e2e-po2',order_no:'E2E-PO',status:'ordered',created_at:new Date().toISOString(),items_json:[item],data_json:{}};
let saved=await rpc('backoffice_purchase_operation',[JSON.stringify(po),null,JSON.stringify({type:'save'})]);po=saved.purchase_order;
const stale=structuredClone(po);
await db.exec("reset role;insert into inventory_items(id,sku,name,category,qty_on_hand) values('scan-other','scan-other','Other model','處理器',1);set role authenticated;");
await db.exec("reset role;insert into inventory_serials(serial_no,item_id,status) values('EXISTING-SN','scan-other','in_stock');set role authenticated;");
const receiptAction={type:'receive',purchase_item_id:item.id,destination:'customer',received_at:'2026-11-07',serial_numbers:['EXISTING-SN']};
await denies(()=>rpc('backoffice_receive_scanned_purchase',[JSON.stringify(po),po.updated_at,JSON.stringify(receiptAction)]),/duplicate/);
await db.exec('reset role');assert.equal((await db.query('select status from purchase_orders where id=$1',[po.id])).rows[0].status,'ordered');assert.equal(Number((await db.query('select count(*) n from inventory_ledger')).rows[0].n),0);await db.exec('set role authenticated');
const receive=await rpc('backoffice_receive_scanned_purchase',[JSON.stringify(po),po.updated_at,JSON.stringify({...receiptAction,serial_numbers:['E2E-SN-002']})]);po=receive.purchase_order;assert.equal(receive.operation.serials_registered,true);

await denies(()=>rpc('backoffice_purchase_operation',[JSON.stringify(stale),stale.updated_at,JSON.stringify({type:'receive',purchase_item_id:item.id,destination:'customer',received_at:'2026-11-07'})]));
const inv=po.items_json[0].receiptInventoryItemId;
await denies(()=>rpc('backoffice_register_receipt_serials',[inv,po.id,item.id,id,'cpu','2026-11-07',JSON.stringify(['e2e-sn-002']),'']),/存在|duplicate|數量/i);



// Old split-write clients remain supported, but cannot forge receipt identity or add excess serials.
await denies(()=>rpc('backoffice_register_receipt_serials',[inv,po.id,item.id,'FAKE-ORDER','cpu','2026-11-07',JSON.stringify(['EXTRA']),'']),/用途不符/);
await denies(()=>rpc('backoffice_register_receipt_serials',[inv,po.id,item.id,id,'cpu','2026-11-07',JSON.stringify(['EXTRA']),'']),/數量/);
await denies(()=>rpc('backoffice_register_receipt_serials',['scan-other',po.id,item.id,id,'cpu','2026-11-07',JSON.stringify(['EXTRA']),'']),/品項.*不符/);
po=(await rpc('backoffice_purchase_operation',[JSON.stringify(po),po.updated_at,JSON.stringify({type:'destination',purchase_item_id:item.id,destination:'inventory',note:'inventory transfer audit'})])).purchase_order;
let lookupBefore=await rpc('backoffice_scan_operation',['lookup','','E2E-SN-002','','']);assert.equal(lookupBefore['紀錄'][0]['狀態'],'in_stock');assert.equal(lookupBefore['紀錄'][0]['訂單編號'],null);
po=(await rpc('backoffice_purchase_operation',[JSON.stringify(po),po.updated_at,JSON.stringify({type:'destination',purchase_item_id:item.id,destination:'customer',note:'back to source order'})])).purchase_order;
lookupBefore=await rpc('backoffice_scan_operation',['lookup','','E2E-SN-002','','']);assert.equal(lookupBefore['紀錄'][0]['狀態'],'reserved');assert.equal(lookupBefore['紀錄'][0]['訂單編號'],'E2E-003');
// Serial lifecycle must also work if the operator uses the ordinary order workflow.
await db.exec('savepoint ordinary_completion');
const ordinaryVersion=(await db.query('select updated_at::text version from orders where id=$1',[id])).rows[0].version;
await rpc('backoffice_update_order_checked',[ordinaryVersion,JSON.stringify({id,order_no:'E2E-003',customer_name:'TEST',sales_type:'整機',shipping_income:0,discount:0,payment_method:'cash',status:'completed',items:[{...lines[0],fulfillment_type:'inventory',item_id:inv}],payment_status:'paid',received_amount:6000,payment_date:'2026-11-07',delivery_status:'delivered',delivered_at:'2026-11-07'})]);await db.exec('set constraints all immediate');
assert.equal((await rpc('backoffice_scan_operation',['lookup','','E2E-SN-002','','']))['紀錄'][0]['狀態'],'sold');await db.exec('rollback to savepoint ordinary_completion;set constraints all deferred');

// Read never enables the workflow. Assembly binds only matching, received serials.
let scan=await rpc('backoffice_scan_operation',['read',id,'','','']);assert.equal(scan.enabled,false);
await denies(()=>rpc('backoffice_scan_operation',['bind',id,'MISSING','cpu','']),/序號尚未入庫/);await denies(()=>rpc('backoffice_scan_operation',['bind',id,'EXISTING-SN','cpu','']),/型號.*不符/);
await denies(()=>rpc('backoffice_scan_operation',['bind',id,'E2E-SN-002','wrong-line','']),/找不到/);
scan=await rpc('backoffice_scan_operation',['bind',id,'e2e-sn-002','cpu','']);assert.equal(scan.lines[0].serials.length,1);
scan=await rpc('backoffice_scan_operation',['bind',id,'E2E-SN-002','cpu','']);assert.equal(scan.lines[0].serials.length,1);
await denies(()=>rpc('backoffice_purchase_operation',[JSON.stringify(po),po.updated_at,JSON.stringify({type:'destination',purchase_item_id:item.id,destination:'inventory',note:'must reject assembled part'})]),/組裝/);assert.equal((await rpc('backoffice_scan_operation',['lookup','','E2E-SN-002','','']))['紀錄'][0]['狀態'],'reserved');
await denies(()=>rpc('backoffice_scan_operation',['ship',id,'E2E-003','','']),/測試/);
await denies(()=>rpc('backoffice_scan_operation',['test',id,'','','短']),/至少/);
scan=await rpc('backoffice_scan_operation',['test',id,'','','FurMark + CPU 30 min passed']);assert.equal(scan.tested,true);
await denies(()=>rpc('backoffice_scan_operation',['ship',id,'OTHER','','']),/編號不符/);
scan=await rpc('backoffice_scan_operation',['ship',id,'E2E-003','','']);assert.equal(scan.ship_checked,true);
// The server rejects completion even when a client bypasses the UI.
await rpc('backoffice_scan_operation',['unbind',id,'E2E-SN-002','cpu','']);
const blockedVersion=(await db.query('select updated_at::text version from orders where id=$1',[id])).rows[0].version;
await denies(async()=>{await rpc('backoffice_update_order_checked',[blockedVersion,JSON.stringify({id,order_no:'E2E-003',customer_name:'TEST',sales_type:'整機',shipping_income:0,discount:0,payment_method:'cash',status:'completed',items:[{...lines[0],fulfillment_type:'inventory',item_id:inv}],payment_status:'paid',received_amount:6000,payment_date:'2026-11-07',delivery_status:'delivered',delivered_at:'2026-11-07'})]);await db.exec('set constraints all immediate');},/掃碼/);
await rpc('backoffice_scan_operation',['bind',id,'E2E-SN-002','cpu','']);await rpc('backoffice_scan_operation',['test',id,'','','test passed after reassembly']);await rpc('backoffice_scan_operation',['ship',id,'E2E-003','','']);

// Removing a part invalidates the previous test and delivery check.
scan=await rpc('backoffice_scan_operation',['unbind',id,'E2E-SN-002','cpu','']);assert.equal(scan.tested,false);
await denies(()=>rpc('backoffice_scan_operation',['test',id,'','','test passed again']),/未核對/);
await rpc('backoffice_scan_operation',['bind',id,'E2E-SN-002','cpu','']);
await rpc('backoffice_scan_operation',['test',id,'','','FurMark + CPU 30 min passed']);
await rpc('backoffice_scan_operation',['ship',id,'E2E-003','','']);

const finalLines=[{...lines[0],fulfillment_type:'inventory',item_id:inv}];
const version=(await db.query('select updated_at::text version from orders where id=$1',[id])).rows[0].version;
const done=await rpc('backoffice_update_order_checked',[version,JSON.stringify({id,order_no:'E2E-003',customer_name:'TEST',sales_type:'整機',shipping_income:0,discount:0,payment_method:'cash',status:'completed',items:finalLines,payment_status:'paid',received_amount:6000,payment_date:'2026-11-07',delivery_status:'delivered',delivered_at:'2026-11-07'})]);assert.equal(done.status,'completed');await db.exec('set constraints all immediate');await db.exec('reset role');assert.equal((await db.query('select status from inventory_serials where serial_no=$1',['E2E-SN-002'])).rows[0].status,'sold');await db.exec('set role authenticated');const lookup=await rpc('backoffice_scan_operation',['lookup','','E2E-SN-002','','']);assert.equal(lookup['紀錄'][0]['訂單編號'],'E2E-003');

await db.exec('savepoint refund_audit');
const refundVersion=(await db.query('select updated_at::text version from orders where id=$1',[id])).rows[0].version;
await rpc('backoffice_update_order_checked',[refundVersion,JSON.stringify({id,order_no:'E2E-003',customer_name:'TEST',sales_type:'整機',shipping_income:0,discount:0,payment_method:'cash',status:'refunded',items:finalLines,payment_status:'paid',received_amount:6000,payment_date:'2026-11-07',delivery_status:'delivered',delivered_at:'2026-11-07'})]);assert.equal((await rpc('backoffice_scan_operation',['lookup','','E2E-SN-002','','']))['紀錄'][0]['狀態'],'returned');
await db.exec('rollback to savepoint refund_audit');

await db.exec('reset role');const counts=await db.query('select (select count(*) from inventory_ledger)::int ledger,(select qty_on_hand from inventory_items where id=$1) qty,(select cogs_total from order_costs where order_id=$2) cost',[inv,id]);assert.equal(Number(counts.rows[0].qty),0);assert.equal(Number(counts.rows[0].cost),4000);assert.equal(Number(counts.rows[0].ledger),4);assert.equal(Number((await db.query("select count(*) n from inventory_ledger where ref_type='PURCHASE_RECEIPT' and item_id=$1",[inv])).rows[0].n),1);
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
await db.exec('set role anon;set request.jwt.claim.sub=\'\';set request.jwt.claim.role=\'anon\';');await denies(()=>rpc('backoffice_scan_operation',['read',id,'','','']),/permission denied/);await denies(()=>db.query('select * from order_scan_checks'),/permission denied/);await denies(()=>db.query('select * from orders'),/permission denied/);await denies(()=>db.query('select * from builder_submissions'),/permission denied/);await db.query("insert into builder_submissions(build_no,payload,status) values('E2E-PUBLIC',$1,'new')",[JSON.stringify({items:[{name:'E2E',qty:1,unit_price:6000}],total:6000,website:''})]);await denies(()=>db.query("insert into builder_submissions(build_no,payload,status) values('E2E-FORGED','{}','converted')"),/row-level security/);await denies(()=>rpc('backoffice_create_order_v2',['BAD','TEST','','','整機',0,0,'cash','confirmed',JSON.stringify(lines)]),/permission denied/);

}finally{await db.exec('rollback');await db.close();}
});
