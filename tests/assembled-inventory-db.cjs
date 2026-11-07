const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),createDb=require('./helpers/current-db.cjs');
test('assembly: preserve book value and both principals, serial provenance, atomic retry, undo and one whole-system sale',{timeout:60000},async()=>{
 const db=await createDb(),migration=fs.readFileSync('supabase/migrations/20261107001254_assembled_system_inventory.sql','utf8');
 const uid='33333333-3333-4333-8333-333333333333',key='11111111-1111-4111-8111-111111111111';
 const rpc=async(name,args)=>(await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') r',args)).rows[0].r;
 const op=(action,k,p={})=>rpc('backoffice_assembly_operation',[action,k,JSON.stringify(p)]);
 const admin=async(fn)=>{await db.exec('reset role');try{return await fn();}finally{await db.exec('set role authenticated');}};
 const totals=()=>admin(async()=> (await db.query(`select (select sum(i.qty_on_hand*c.cost_unit) from inventory_items i join inventory_costs c on c.item_id=i.id) book,coalesce(sum(qty_remaining*unit_cost) filter(where owner='boss'),0) boss,coalesce(sum(qty_remaining*unit_cost) filter(where owner='hala'),0) hala from inventory_funding_lots`)).rows[0]).then(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v)])));
 try{
 await db.exec(migration);await db.exec(migration);
 await db.exec(`insert into auth.users(id) values('${uid}');insert into profiles(id,username,role,enabled) values('${uid}','assembly-admin','admin',true);insert into inventory_inbound_settings(id,tracking_start_date) values('default','2026-01-01');insert into inventory_items(id,sku,name,category,condition,status,qty_on_hand) values('CPU','CPU','CPU','處理器','NEW','READY',0),('RAM','RAM','RAM','記憶體','NEW','READY',0);set role authenticated;set request.jwt.claim.sub='${uid}';set request.jwt.claim.role='authenticated';`);
 for(const [id,cost,owner] of [['CPU',1000,'boss'],['RAM',500,'hala']]){
  const inbound=await rpc('backoffice_admin_adjust_stock',[id,2,'IN',cost,'Synthetic initial stock','2026-11-07',null,null,null]);await rpc('backoffice_assign_inbound_funding',[inbound.ledger_id,owner]);
 }
 await admin(()=>db.exec("insert into inventory_serials(serial_no,item_id,status) values('CPU-001','CPU','in_stock'),('CPU-002','CPU','in_stock')"));
 const original=await totals();assert.deepEqual(Object.values(original).map(Number),[3000,2000,1000]);
 const payload={name:'Synthetic assembled PC',serial_no:'DK-ASM-001',parts:[{item_id:'CPU',qty:1,serials:['cpu-001']},{item_id:'RAM',qty:1,serials:[],serial_note:'原廠未提供序號'}]};
 const count=()=>admin(async()=>(await db.query('select count(*) n from inventory_ledger')).rows[0].n);
 const n=await count(),plan=await op('preview',null,payload);assert.equal(await count(),n);assert.equal(Number(plan.material_cost),1500);assert.deepEqual(JSON.parse(JSON.stringify(plan.funding)),{boss:1000,hala:500});
 await assert.rejects(()=>op('create',key,{...payload,signature:plan.signature}),/先核對/);
 await assert.rejects(()=>op('preview',null,{...payload,parts:[{...payload.parts[0],serials:['MISSING']},payload.parts[1]]}),/序號/);
 await assert.rejects(()=>op('preview',null,{...payload,parts:[{...payload.parts[0],qty:3},payload.parts[1]]}),/庫存/);
 await admin(()=>db.exec("update inventory_items set notes='changed' where id='CPU'"));await assert.rejects(()=>op('create',key,{...payload,signature:plan.signature,reviewed:true}),/重新預覽/);assert.equal(await count(),n);
 const fresh=await op('preview',null,payload),body={...payload,signature:fresh.signature,reviewed:true};
 // Inject a failure at the final serial insert: every earlier stock/funding write must roll back.
 await admin(()=>db.exec("create function public.test_abort_assembly_serial() returns trigger language plpgsql as $$begin if NEW.serial_no='DK-FAIL' then raise exception 'synthetic late failure'; end if;return NEW;end$$;create trigger test_late_assembly_failure before insert on inventory_serials for each row execute function test_abort_assembly_serial()"));
 await assert.rejects(()=>op('create','55555555-5555-4555-8555-555555555555',{...body,serial_no:'DK-FAIL'}),/late failure/);
 assert.deepEqual(await totals(),original);assert.equal(await count(),n);
 await admin(()=>db.exec('drop trigger test_late_assembly_failure on inventory_serials;drop function public.test_abort_assembly_serial()'));
 const created=await op('create',key,body);assert.ok(created.item_id);assert.deepEqual(await totals(),original);assert.equal(Number(await count()),Number(n)+3);
 const retry=await op('create',key,body);assert.equal(retry.idempotent,true);assert.equal(retry.id,created.id);await assert.rejects(()=>op('create',key,{...body,name:'Different'}),/其他內容/);
 const trace=await op('trace',null,{serial:'cpu-001'});assert.equal(trace[0]['整機序號'],'DK-ASM-001');
 assert.equal((await op('list',null))[0].serial_status,'in_stock');
 // Neither a manual stock edit, direct source reassignment, extra funding lot nor fractional sale can bypass conversion.
 await assert.rejects(()=>rpc('backoffice_admin_adjust_stock',[created.item_id,1,'IN',1500,'Wrong duplicate stock',null,null,null,null]),/不可手動|只有一台/);
 await assert.rejects(()=>rpc('backoffice_inventory_item_funding',[created.item_id,'boss']),/重新歸屬/);
 const inboundId=await admin(async()=>(await db.query("select id from inventory_ledger where item_id=$1 and movement_type='MANUAL_IN'",[created.item_id])).rows[0].id);
 await assert.rejects(()=>rpc('backoffice_assign_inbound_funding',[inboundId,'hala']),/另外新增/);
 await assert.rejects(()=>rpc('backoffice_upsert_item',[JSON.stringify({id:created.item_id,name:'Edited name'}),999]),/不能直接改/);
 const orderPayload={order_no:'ASSEMBLY-SALE',customer_name:'Synthetic Buyer',sales_type:'整機',status:'confirmed',shipping_income:0,discount:0,items:[{line_key:'pc',fulfillment_type:'inventory',item_id:created.item_id,name:'Synthetic PC',category:'整機',qty:0.5,unit_price:5000}]};
 await assert.rejects(()=>rpc('backoffice_create_order_checked',[JSON.stringify(orderPayload)]),/小數|只有一台/);
 assert.deepEqual(await totals(),original);
 // An untouched system can be physically disassembled; append-only movement and provenance remain.
 await op('disassemble',created.id,{reviewed:true});assert.deepEqual(await totals(),original);assert.equal((await op('list',null))[0].state,'disassembled');assert.equal((await op('trace',null,{serial:'CPU-001'}))[0]['組裝狀態'],'disassembled');assert.equal((await op('disassemble',created.id,{reviewed:true})).idempotent,true);
 const serial=await admin(async()=>(await db.query("select status,assembly_id from inventory_serials where serial_no='CPU-001'")).rows[0]);assert.equal(serial.status,'in_stock');assert.equal(serial.assembly_id,null);
 // Build again, sell the whole once, verify BOSS repayment principal activates only on the whole sale.
 const second={...payload,serial_no:'DK-ASM-002'},p2=await op('preview',null,second),c2=await op('create','22222222-2222-4222-8222-222222222222',{...second,signature:p2.signature,reviewed:true});
 const eligibleBefore=await admin(async()=>(await db.query("select coalesce(sum((qty-reversed_qty)*unit_cost),0) amount from inventory_funding_allocations where repayment_eligible and owner='boss'")).rows[0].amount);assert.equal(Number(eligibleBefore),0);
 const lines=[{...orderPayload.items[0],item_id:c2.item_id,qty:1}],order=await rpc('backoffice_create_order_checked',[JSON.stringify({...orderPayload,items:lines})]);
 await assert.rejects(()=>op('disassemble',c2.id,{reviewed:true}),/預留|出售/);
 const state=await totals();assert.deepEqual(Object.values(state).map(Number),[1500,1000,500]);
 const costs=await admin(async()=>(await db.query('select cogs_total from order_costs where order_id=$1',[order.id])).rows[0].cogs_total);assert.equal(Number(costs),1500);
 const funding=await rpc('backoffice_order_funding',[order.id,JSON.stringify([{item_id:c2.item_id,qty:1}])]);assert.equal(funding[0].mode,'actual');assert.equal(Number(funding[0].boss_qty)+Number(funding[0].hala_qty),1);
 const update=async(status)=>{const v=await admin(async()=>(await db.query('select updated_at::text v from orders where id=$1',[order.id])).rows[0].v);return rpc('backoffice_update_order_checked',[v,JSON.stringify({...orderPayload,id:order.id,items:lines,status,payment_status:'paid',received_amount:5000,payment_date:'2026-11-07',delivery_status:'delivered',delivered_at:'2026-11-07'})]);};
 await db.exec('begin');await update('completed');await db.exec('set constraints all immediate');assert.equal((await op('trace',null,{serial:'CPU-001'}))[0]['整機序號狀態'],'sold');await db.exec('rollback');
 await rpc('backoffice_scan_operation',['bind',order.id,'DK-ASM-002','pc','']);await rpc('backoffice_scan_operation',['test',order.id,'','','Synthetic burn-in passed']);await rpc('backoffice_scan_operation',['ship',order.id,'ASSEMBLY-SALE','','']);
 await update('completed');assert.deepEqual(await totals(),state);await update('refunded');assert.deepEqual(await totals(),original);
 await assert.rejects(()=>op('disassemble',c2.id,{reviewed:true}),/預留|出售/);
 const partQty=await admin(async()=>(await db.query("select qty_on_hand from inventory_items where id='CPU'")).rows[0].qty_on_hand);assert.equal(Number(partQty),1); // refund restores a whole, never its components twice
 // RPC and private data remain restricted to enabled administrators.
 await admin(()=>db.query("update profiles set role='staff' where id=$1",[uid]));await assert.rejects(()=>op('list',null),/permission denied/);await assert.rejects(()=>db.query('select * from inventory_assemblies'),/permission denied/);
 await db.exec("set role anon;set request.jwt.claim.sub=''");await assert.rejects(()=>op('list',null),/permission denied/);
 }finally{await db.close();}
});
