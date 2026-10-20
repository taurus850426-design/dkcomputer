const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {PGlite}=require('@electric-sql/pglite');
test('manual launch: private schema, server totals, stock holds, expiry, transfer reporting and exactly-once fulfillment',async()=>{
 const db=new PGlite();await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE TABLE inventory(id text PRIMARY KEY,name text,price numeric,qty integer,stock_status text,photos jsonb,created_at timestamptz DEFAULT now());INSERT INTO inventory VALUES('pc','PC',100,2,'現貨','[]',now()),('WEB-014','multi-model',888,8,'現貨','[]',now());CREATE TABLE orders(id text);INSERT INTO orders VALUES('existing-order');");
 await db.exec(fs.readFileSync('shop-server/schema.sql','utf8'));await db.exec(fs.readFileSync('supabase/migrations/20261020232114_shop_manual_launch.sql','utf8'));
 const call=async(name,args=[])=> (await db.query('SELECT '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS result',args)).rows[0].result;
 let n=0;const token='a'.repeat(64);async function submit({payment='transfer',qty=1,product='pc',ip,environment='live',contact={}}={}){n++;return call('shop_submit',[`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,token,'hash'+n,ip||'ip'+n,{name:'測試客戶',phone:'0912345678',email:'test@example.com',fulfillment:'pickup',payment,...contact},[{id:product,qty,price:1}],environment]);}
 assert.equal((await call('shop_catalog')).find(x=>x.id==='WEB-014').requires_quote,true);
 await assert.rejects(submit({product:'WEB-014'}),/unavailable/);await assert.rejects(submit({payment:'credit'}),/invalid customer/);await assert.rejects(submit({contact:{name:null}}),/invalid customer/);await assert.rejects(submit({contact:{fulfillment:'delivery',address:'short'}}),/delivery/);
 const order=await submit();assert.equal(order.subtotal,100);assert.equal(order.items[0].unit_price,100);
 assert.equal((await call('shop_submit',[order.request_key,token,order.request_hash,order.ip_hash,order.customer,[],order.environment])).id,order.id);
 await assert.rejects(call('shop_submit',[order.request_key,token,'different',order.ip_hash,order.customer,[],order.environment]),/conflict/);
 await assert.rejects(call('shop_approve_manual',[order.id,order.updated_at,10,'Please contact LINE']),/shipping/);
 const approved=await call('shop_approve_manual',[order.id,order.updated_at,0,'Please contact LINE for transfer details']);assert.equal(approved.status,'awaiting_payment');assert.ok(approved.hold_until);assert.equal((await call('shop_catalog')).find(x=>x.id==='pc').qty,1);
 const other=await submit({qty:2});await assert.rejects(call('shop_approve_manual',[other.id,other.updated_at,0,'Please contact LINE']),/insufficient/);
 await assert.rejects(call('shop_report_transfer',[order.id,'b'.repeat(64),'12345']),/invalid/);
 await assert.rejects(call('shop_report_transfer',[order.id,token,'12']),/invalid/);
 const reported=await call('shop_report_transfer',[order.id,token,'12345']);assert.equal(reported.status,'payment_review');assert.equal(reported.paid_at,null);assert.equal((await call('shop_report_transfer',[order.id,token,'12345'])).updated_at,reported.updated_at);
 await assert.rejects(call('shop_manual_payment',[order.id,approved.updated_at,'receipt']),/version/);
 const paid=await call('shop_manual_payment',[order.id,reported.updated_at,'bank receipt']);assert.equal(paid.status,'paid');assert.ok(paid.paid_at);
 await assert.rejects(call('shop_cancel',[paid.id,paid.updated_at]),/cancellation/);
 const shipped=await call('shop_fulfill',[paid.id,paid.updated_at]);assert.equal(shipped.status,'fulfilled');assert.equal((await db.query("SELECT qty FROM inventory WHERE id='pc'")).rows[0].qty,1);await assert.rejects(call('shop_fulfill',[shipped.id,shipped.updated_at]));
 const expired=await submit();await call('shop_approve_manual',[expired.id,expired.updated_at,0,'Please contact LINE']);await db.query("UPDATE shop_orders SET hold_until=now()-interval '1 minute' WHERE id=$1",[expired.id]);await call('shop_expire_unpaid');assert.equal((await db.query('SELECT status FROM shop_orders WHERE id=$1',[expired.id])).rows[0].status,'cancelled');
 const store=await submit({payment:'store',environment:'test'});const sa=await call('shop_approve_manual',[store.id,store.updated_at,0,'Please arrange pickup']);assert.equal(sa.hold_until,null);const sp=await call('shop_manual_payment',[store.id,sa.updated_at,'cash receipt']);assert.equal(sp.status,'test_paid');await assert.rejects(call('shop_fulfill',[sp.id,sp.updated_at]));
 const repriced=await submit();await db.query("UPDATE inventory SET price=101 WHERE id='pc'");await assert.rejects(call('shop_approve_manual',[repriced.id,repriced.updated_at,0,'Please contact LINE']),/price changed/);
 for(let i=0;i<5;i++)await submit({ip:'limited'});await assert.rejects(submit({ip:'limited'}),/too many/);
 assert.equal((await db.query('SELECT id FROM orders')).rows[0].id,'existing-order');
 for(const role of ['anon','authenticated']){await db.exec('SET ROLE '+role);await assert.rejects(db.query('SELECT * FROM shop_orders'),/permission denied/);await assert.rejects(db.query('SELECT * FROM shop_settings'),/permission denied/);await assert.rejects(call('shop_catalog'),/permission denied/);await assert.rejects(call('shop_manual_payment',[store.id,sp.updated_at,'fake']),/permission denied/);await db.exec('RESET ROLE');}
 await db.close();
});
