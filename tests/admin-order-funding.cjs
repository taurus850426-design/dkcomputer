const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const {PGlite}=require('@electric-sql/pglite');const {describe,populate}=require('../admin-order-funding.js');
test('funding display distinguishes actual, estimated, mixed and incomplete data',()=>{
 assert.equal(describe({mode:'actual',boss_qty:1,hala_qty:0,requested_qty:1}).label,'BOSS');
 assert.equal(describe({mode:'actual',boss_qty:0,hala_qty:2,requested_qty:2}).label,'HALA');
 assert.equal(describe({mode:'estimated',boss_qty:1,hala_qty:1,requested_qty:2}).label,'HALA／BOSS（預估）');
 assert.equal(describe({mode:'incomplete',boss_qty:0,hala_qty:0,requested_qty:1}).label,'待確認');
 assert.equal(describe(null).label,'待確認');
});
const cell=index=>({dataset:{orderFunding:String(index)},isConnected:true,textContent:'',hidden:false,title:''});
test('funding reads never assign an owner, and staff make no requests',async()=>{
 const c=cell(0),tbody={querySelectorAll:()=>[c]},lines=[{item_id:'pc',qty:1,fulfillment_type:'inventory'}];let calls=0;
 const dk={stage7OrderFunding:async(id,rows)=>{calls++;assert.equal(id,'order');assert.deepEqual(rows,[{item_id:'pc',qty:1}]);return {ok:true,data:[{item_id:'pc',mode:'actual',boss_qty:0,hala_qty:1,requested_qty:1}]};}};
 await populate(tbody,dk,'order',lines,()=>false);assert.equal(calls,0);await populate(tbody,dk,'order',lines,()=>true);assert.equal(calls,1);assert.equal(c.textContent,'HALA');
});
test('a stale response cannot overwrite the next order, and failures never guess BOSS',async()=>{
 const c=cell(0),tbody={querySelectorAll:()=>[c]},lines=[{item_id:'pc',qty:1}];let finish;
 const first=populate(tbody,{stage7OrderFunding:()=>new Promise(r=>finish=r)},'old',lines,()=>true);
 await populate(tbody,{stage7OrderFunding:async()=>({ok:false})},'new',lines,()=>true);
 finish({ok:true,data:[{item_id:'pc',mode:'actual',boss_qty:1,hala_qty:0,requested_qty:1}]});await first;assert.equal(c.textContent,'待確認');
});
test('service and unreceived procurement have explicit non-owner labels and do not query',async()=>{
 const cells=[cell(0),cell(1)],tbody={querySelectorAll:()=>cells};await populate(tbody,{stage7OrderFunding:()=>{throw Error('should not query')}},null,[{fulfillment_type:'service'},{fulfillment_type:'procurement'}],()=>true);assert.equal(cells[0].textContent,'不適用');assert.equal(cells[1].textContent,'待到貨確認');
});
test('readonly funding RPC respects actual allocation history, previews existing priority, and rejects staff/anon',async()=>{
 const db=new PGlite();await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE FUNCTION public.dk_require_backoffice() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('test.role',true) $$;CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.role',true)='admin' $$;
 CREATE TABLE public.orders(id text,status text);CREATE TABLE public.inventory_ledger(id text,item_id text,ref_type text,ref_id text,movement_type text);
 CREATE TABLE public.inventory_funding_allocations(outbound_ledger_id text,owner text,qty numeric,reversed_qty numeric);CREATE TABLE public.inventory_funding_lots(item_id text,owner text,qty_remaining numeric);
 INSERT INTO orders VALUES('saved','completed'),('legacy','completed'),('draft','negotiating');INSERT INTO inventory_ledger VALUES('out','pc','ORDER','saved','SALE');INSERT INTO inventory_funding_allocations VALUES('out','boss',2,1);INSERT INTO inventory_funding_lots VALUES('pc','hala',10),('mixed','boss',1),('mixed','hala',5);SET test.role='admin';`);
 await db.exec(fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20261022044046_order_funding_display.sql'),'utf8'));
 const call=async(id,lines)=>(await db.query('SELECT public.backoffice_order_funding($1,$2) AS result',[id,lines])).rows[0].result;
 const before=await db.query('SELECT * FROM inventory_funding_lots');
 let r=await call('saved',[{item_id:'pc',qty:1}]);assert.equal(r[0].mode,'actual');assert.equal(r[0].boss_qty,1);assert.equal(r[0].hala_qty,0);
 r=await call(null,[{item_id:'mixed',qty:1},{item_id:'mixed',qty:1}]);assert.equal(r.length,1);assert.equal(r[0].mode,'estimated');assert.equal(r[0].boss_qty,1);assert.equal(r[0].hala_qty,1);
 assert.equal((await call('legacy',[{item_id:'pc',qty:1}]))[0].mode,'incomplete');assert.equal((await call('saved',[{item_id:'pc',qty:2}]))[0].mode,'incomplete');assert.equal((await call(null,[{item_id:'unknown',qty:1}]))[0].mode,'incomplete');
 await assert.rejects(call(null,[{item_id:'pc',qty:0}]),/invalid quantity/);await assert.rejects(call('missing',[{item_id:'pc',qty:1}]),/not found/);
 assert.deepEqual((await db.query('SELECT * FROM inventory_funding_lots')).rows,before.rows);
 await db.exec("SET test.role='staff'; SET ROLE authenticated");await assert.rejects(call(null,[{item_id:'pc',qty:1}]),/permission denied/);await db.exec('RESET ROLE;SET ROLE anon');await assert.rejects(call(null,[{item_id:'pc',qty:1}]),/permission denied/);await db.close();
});
