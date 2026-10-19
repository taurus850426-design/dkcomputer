const {test}=require('node:test');const assert=require('node:assert/strict');
test('Edge endpoints guard origin, disabled checkout, admin and ownership; signed callback acknowledges only verified write',async()=>{
 const originalFetch=global.fetch,originalDeno=global.Deno;let handler,failWrite=false;const calls=[];
 const vars={SUPABASE_URL:'https://project.example',SUPABASE_SERVICE_ROLE_KEY:'server-only',SUPABASE_ANON_KEY:'anon',SHOP_ORIGIN:'https://shop.example',SHOP_ENABLED:'false',ECPAY_MODE:'test',ECPAY_MERCHANT_ID:'3002607',ECPAY_HASH_KEY:'pwFHCqoQZGmho4w6',ECPAY_HASH_IV:'EkRm7iFT261dpevs'};
 global.Deno={env:{get:k=>vars[k]},serve:fn=>{handler=fn;}};
 global.fetch=async(url,options={})=>{calls.push({url,options});if(url.includes('/auth/v1/user'))return Response.json({id:'admin-id'});if(url.includes('/profiles'))return Response.json([{role:'admin',enabled:true}]);if(url.includes('/shop_orders'))return Response.json([]);if(url.includes('/shop_apply_payment'))return failWrite?new Response('database down',{status:503}):Response.json({status:'test_paid'});throw Error('Unexpected fetch');};
 try{
 await import('../supabase/functions/shop-checkout/index.ts');
 async function post(body,origin='https://shop.example',auth){return handler(new Request('https://project.example/functions/v1/shop-checkout',{method:'POST',headers:{origin,'Content-Type':'application/json',...(auth?{Authorization:auth}:{})},body:JSON.stringify(body)}));}
 assert.equal((await post({action:'config'},'https://evil.example')).status,403);
 assert.equal((await (await post({action:'config'})).json()).enabled,false);
 assert.equal((await post({action:'create'})).status,503);assert.equal(calls.length,0);
 assert.equal((await post({action:'list'})).status,403);assert.equal(calls.length,0);
 assert.equal((await post({action:'status',id:'bad',token:'bad'})).status,400);assert.equal(calls.length,0);
 assert.equal((await post({action:'list'},'https://shop.example','Bearer admin-token')).status,200);
 assert.ok(calls.find(x=>x.url.includes('/profiles')));
 vars.SHOP_ENABLED='true';assert.equal((await post({action:'create'})).status,403);
 const {checkMac}=await import('../supabase/functions/shop-checkout/ecpay.mjs');const f={MerchantID:vars.ECPAY_MERCHANT_ID,MerchantTradeNo:'DK123',TradeNo:'gateway123',TradeAmt:'200',RtnCode:'1',SimulatePaid:'1'};f.CheckMacValue=await checkMac(f,vars.ECPAY_HASH_KEY,vars.ECPAY_HASH_IV);
 const notify=fields=>handler(new Request('https://project.example/functions/v1/shop-checkout/notify',{method:'POST',body:new URLSearchParams(fields)}));
 assert.equal(await (await notify(f)).text(),'1|OK');
 const before=calls.length;assert.equal((await notify({...f,TradeAmt:'1'})).status,400);assert.equal(calls.length,before);
 failWrite=true;assert.equal((await notify(f)).status,400);
 }finally{global.fetch=originalFetch;global.Deno=originalDeno;}
});
