const {test}=require('node:test');const assert=require('node:assert/strict');
test('manual Edge: cards disabled, admin role checked, anti-bot challenge and ownership enforced',async()=>{
 const oldFetch=global.fetch,oldDeno=global.Deno;let handler,enabled=false,role='admin';const calls=[];const vars={SUPABASE_URL:'https://project.example',SUPABASE_SERVICE_ROLE_KEY:'server-only',SUPABASE_ANON_KEY:'anon',SHOP_ORIGIN:'https://shop.example'};
 global.Deno={env:{get:k=>vars[k]},serve:fn=>{handler=fn;}};
 global.fetch=async(url,options={})=>{calls.push({url,options});if(url.includes('/auth/v1/user'))return Response.json({id:'00000000-0000-4000-8000-000000000001'});if(url.includes('/profiles'))return Response.json([{role,enabled:true}]);if(url.includes('/shop_settings'))return Response.json([{enabled}]);if(url.includes('/shop_orders'))return Response.json([]);if(url.includes('/shop_expire_unpaid'))return Response.json(null);if(url.includes('/shop_catalog'))return Response.json([]);if(url.includes('/shop_submit'))return Response.json({id:'new',order_no:'WEB1',items:[],status:'awaiting_confirmation',subtotal:100,payment:'transfer'});throw Error('Unexpected fetch '+url);};
 try{
  await import('../supabase/functions/shop-checkout/index.ts');
  const post=(body,origin='https://shop.example',auth)=>handler(new Request('https://project.example/functions/v1/shop-checkout',{method:'POST',headers:{origin,'Content-Type':'application/json','x-forwarded-for':'127.0.0.1',...(auth?{Authorization:auth}:{})},body:JSON.stringify(body)}));
  assert.equal((await post({action:'config'},'https://evil.example')).status,403);
  assert.equal((await (await post({action:'config'})).json()).enabled,false);
  assert.equal((await post({action:'create'})).status,503);
  assert.equal((await post({action:'pay'})).status,410);
  assert.equal((await handler(new Request('https://project.example/functions/v1/shop-checkout/notify',{method:'POST'}))).status,410);
  assert.equal((await post({action:'list'})).status,403);
  role='staff';assert.equal((await post({action:'list'},'https://shop.example','Bearer staff')).status,403);role='admin';assert.equal((await post({action:'list'},'https://shop.example','Bearer admin')).status,200);
  assert.equal((await post({action:'status',id:'bad',token:'bad'})).status,400);
  assert.equal((await post({action:'status',id:'00000000-0000-4000-8000-000000000099',token:'a'.repeat(64)})).status,400);
  enabled=true;assert.equal((await post({action:'create',challenge:'fake',consent:true})).status,400);
  const {issueChallenge,hmac,verifyChallenge,publicOrder}=await import('../supabase/functions/shop-checkout/manual.mjs');const ipHash=await hmac('server-only','dk-shop-ip:127.0.0.1');const challenge=await issueChallenge('server-only',ipHash,Date.now()-2000);
  assert.equal(await verifyChallenge(challenge,'server-only','different-ip'),false);assert.equal(await verifyChallenge(challenge,'wrong-secret',ipHash),false);
  const tooNew=await issueChallenge('server-only',ipHash);assert.equal(await verifyChallenge(tooNew,'server-only',ipHash),false);const expired=await issueChallenge('server-only',ipHash,Date.now()-3601000);assert.equal(await verifyChallenge(expired,'server-only',ipHash),false);
  const body={action:'create',challenge,consent:true,key:'00000000-0000-4000-8000-000000000002',token:'b'.repeat(64),cart:[{id:'pc',qty:1,price:1}],customer:{name:'測試客戶',phone:'0912345678',email:'test@example.com',fulfillment:'pickup',payment:'transfer'}};
  assert.equal((await post({...body,website:'spam'})).status,400);
  assert.equal((await post({...body,customer:{...body.customer,payment:'credit'}})).status,400);
  assert.equal((await post(body)).status,200);
  const create=calls.find(x=>x.url.includes('/shop_submit'));const args=JSON.parse(create.options.body);assert.deepEqual(args.p_cart,[{id:'pc',qty:1}]);assert.equal(args.p_environment,'live');assert.notEqual(args.p_token_hash,body.token);
  assert.equal(publicOrder({id:'one',customer:{phone:'private'},token_hash:'secret',ip_hash:'private'}).customer,undefined);
 }finally{global.fetch=oldFetch;global.Deno=oldDeno;}
});
