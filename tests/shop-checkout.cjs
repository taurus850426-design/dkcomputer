const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const core=require('../shop-core.js');
test('cart normalizes IDs and quantities without trusting price',()=>{assert.deepEqual(core.normalizeCart([{id:'a',qty:1,price:1},{id:'a',qty:2},{id:'b',qty:0}]),[{id:'a',qty:3}]);assert.equal(core.quote([{id:'a',qty:2,price:1}],[{id:'a',name:'PC',price:100,qty:3}]).total,200);});
test('unlisted, unpriced and unavailable products block checkout',()=>{assert.equal(core.quote([{id:'a',qty:2}],[{id:'a',price:100,qty:1}]).errors.length,1);assert.equal(core.quote([{id:'a',qty:1}],[{id:'a',price:null,qty:1}]).errors.length,1);assert.equal(core.quote([{id:'none',qty:1}],[]).errors.length,1);});
test('delivery cannot use store payment or incomplete address',()=>{const c={name:'測試客戶',phone:'0912345678',email:'test@example.com',fulfillment:'delivery',address:'台灣台北市測試路一號',payment:'store'};assert.throws(()=>core.validateCustomer(c));c.payment='credit';assert.equal(core.validateCustomer(c).payment,'credit');c.address='短';assert.throws(()=>core.validateCustomer(c));});
test('ECPay SHA256 matches official vector',async()=>{const {checkMac}=await import('../supabase/functions/shop-checkout/ecpay.mjs');const fields={TradeDesc:'促銷方案',PaymentType:'aio',MerchantTradeDate:'2023/03/12 15:30:23',MerchantTradeNo:'ecpay20230312153023',MerchantID:'3002607',ReturnURL:'https://www.ecpay.com.tw/receive.php',ItemName:'Apple iphone 15',TotalAmount:'30000',ChoosePayment:'ALL',EncryptType:'1'};assert.equal(await checkMac(fields,'pwFHCqoQZGmho4w6','EkRm7iFT261dpevs'),'6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840');});
test('signed notifications reject tampering and simulated live payments',async()=>{const {checkMac,verifyNotification}=await import('../supabase/functions/shop-checkout/ecpay.mjs');const c={mode:'live',merchant:'liveid',key:'key',iv:'iv'};const fields={MerchantID:'liveid',MerchantTradeNo:'DK123',TradeNo:'gateway123',TradeAmt:'200',RtnCode:'1',SimulatePaid:'0'};fields.CheckMacValue=await checkMac(fields,c.key,c.iv);assert.equal((await verifyNotification(fields,c)).amount,200);await assert.rejects(verifyNotification({...fields,TradeAmt:'1'},c));const sim={...fields,SimulatePaid:'1'};sim.CheckMacValue=await checkMac(sim,c.key,c.iv);await assert.rejects(verifyNotification(sim,c));});
test('live payment cannot use public test credentials',async()=>{const {paymentConfiguration}=await import('../supabase/functions/shop-checkout/ecpay.mjs');const env={ECPAY_MODE:'live',ECPAY_MERCHANT_ID:'3002607',ECPAY_HASH_KEY:'key',ECPAY_HASH_IV:'iv',SHOP_LIVE_APPROVED:'true'};assert.throws(()=>paymentConfiguration(k=>env[k]));});
test('database: server pricing, approval holds, callback idempotency and isolated fulfillment',async()=>{
 const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();
 await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE public.inventory(id text PRIMARY KEY,name text,price numeric,qty integer); CREATE TABLE public.orders(id text); INSERT INTO public.orders VALUES(\'old-order\'); INSERT INTO public.inventory VALUES(\'pc\',\'測試主機\',100,2);');
 await db.exec(fs.readFileSync('shop-server/schema.sql','utf8'));
 async function call(name,args){const a=args.map((_,i)=>'$'+(i+1)).join(',');return (await db.query('SELECT public.'+name+'('+a+') AS result',args)).rows[0].result;}
 let seq=0;async function submit(env='live',payment='credit',qty=1){seq++;return call('shop_submit',[`00000000-0000-4000-8000-${String(seq).padStart(12,'0')}`,'a'.repeat(64),'request'+seq,'ip'+seq,JSON.stringify({name:'測試客戶',phone:'0912345678',fulfillment:'pickup',payment}),JSON.stringify([{id:'pc',qty,price:1}]),env]);}
 const one=await submit();assert.equal(one.subtotal,100);
 const repeat=await call('shop_submit',[one.request_key,one.token_hash,one.request_hash,one.ip_hash,one.customer,[],one.environment]);assert.equal(repeat.id,one.id);
 await assert.rejects(call('shop_submit',[one.request_key,one.token_hash,'changed',one.ip_hash,one.customer,[],one.environment]),/conflict/);
 const approved=await call('shop_approve',[one.id,one.updated_at,0]);
 const two=await submit('live','credit',2);await assert.rejects(call('shop_approve',[two.id,two.updated_at,0]),/insufficient/);
 const started=await call('shop_start_payment',[one.id,one.token_hash]);await assert.rejects(call('shop_start_payment',[one.id,one.token_hash]),/already/);
 await assert.rejects(call('shop_apply_payment',[started.trade_no,1,'gateway','live',false,true]),/mismatch/);
 await assert.rejects(call('shop_apply_payment',[started.trade_no,100,'gateway','live',true,true]),/mismatch/);
 const paid=await call('shop_apply_payment',[started.trade_no,100,'gateway','live',false,true]);assert.equal(paid.status,'paid');
 const shipped=await call('shop_fulfill',[paid.id,paid.updated_at]);assert.equal(shipped.status,'fulfilled');assert.equal((await db.query('SELECT qty FROM inventory')).rows[0].qty,1);
 await assert.rejects(call('shop_fulfill',[shipped.id,shipped.updated_at]));
 assert.equal((await call('shop_apply_payment',[started.trade_no,100,'gateway','live',false,true])).status,'fulfilled');
 assert.equal((await call('shop_apply_payment',[started.trade_no,100,'gateway','live',false,false])).status,'fulfilled');
 assert.equal((await db.query('SELECT * FROM orders')).rows[0].id,'old-order');
 const mock=await submit('test','store');const ma=await call('shop_approve',[mock.id,mock.updated_at,0]);const mp=await call('shop_manual_payment',[ma.id,ma.updated_at,'test receipt']);assert.equal(mp.status,'test_paid');await assert.rejects(call('shop_fulfill',[mp.id,mp.updated_at]));
 await db.exec('SET ROLE anon');await assert.rejects(db.query('SELECT * FROM shop_orders'),/permission denied/);await assert.rejects(call('shop_cancel',[mock.id,mock.updated_at]),/permission denied/);await db.exec('RESET ROLE');await db.close();
});
