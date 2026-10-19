import { sha256, paymentConfiguration, paymentFields, verifyNotification } from './ecpay.mjs';
const env=(key:string)=>Deno.env.get(key)||'';
const project=env('SUPABASE_URL'),secret=env('SUPABASE_SERVICE_ROLE_KEY');
const origin=env('SHOP_ORIGIN');
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'content-type,authorization','Access-Control-Allow-Methods':'POST,OPTIONS','Cache-Control':'no-store','Vary':'Origin'}});}
async function request(path:string,options:RequestInit={}){
 const response=await fetch(project+path,{...options,headers:{apikey:secret,Authorization:'Bearer '+secret,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('Database operation failed: '+(await response.text()).slice(0,500));
 return response.status===204?null:await response.json();
}
const rpc=(name:string,args:unknown)=>request('/rest/v1/rpc/'+name,{method:'POST',body:JSON.stringify(args)});
async function admin(req:Request){
 const auth=req.headers.get('Authorization')||'';if(!/^Bearer .+/.test(auth))throw Error('Admin sign-in required');
 const response=await fetch(project+'/auth/v1/user',{headers:{apikey:env('SUPABASE_ANON_KEY'),Authorization:auth},signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Admin sign-in required');const user=await response.json();
 const rows=await request('/rest/v1/profiles?id=eq.'+encodeURIComponent(user.id)+'&select=role,enabled');
 if(rows[0]?.role!=='admin'||rows[0]?.enabled!==true)throw Error('Admin permission required');
}
function customer(raw:any){
 const out={name:String(raw?.name||'').trim(),phone:String(raw?.phone||'').replace(/[\s-]/g,''),email:String(raw?.email||'').trim(),fulfillment:raw?.fulfillment,address:String(raw?.address||'').trim(),note:String(raw?.note||'').trim(),payment:raw?.payment};
 if(out.name.length<2||out.name.length>80||!/^\+?[0-9]{8,15}$/.test(out.phone)||out.email.length>160||!/^\S+@\S+\.\S+$/.test(out.email)||!['pickup','delivery'].includes(out.fulfillment)||!['credit','transfer','store'].includes(out.payment)||out.note.length>500)throw Error('Invalid contact details');
 if(out.fulfillment==='delivery'&&(out.address.length<8||out.address.length>300))throw Error('Delivery address required');
 if(out.fulfillment==='pickup')out.address='';if(out.payment==='store'&&out.fulfillment!=='pickup')throw Error('Store payment requires pickup');return out;
}
async function owned(id:string,token:string){
 if(!/^[0-9a-f-]{36}$/i.test(id)||!(/^[0-9a-f]{64}$/).test(token))throw Error('Request not found');
 const rows=await request('/rest/v1/shop_orders?id=eq.'+id+'&token_hash=eq.'+await sha256(token)+'&select=*');if(!rows.length)throw Error('Request not found');return rows[0];
}
function publicOrder(row:any){return {id:row.id,order_no:row.order_no,status:row.status,subtotal:row.subtotal,shipping_fee:row.shipping_fee,payment:row.payment,environment:row.environment};}
async function notification(req:Request){
 try{
  if(req.method!=='POST'||Number(req.headers.get('content-length')||0)>32768)throw Error('Invalid request');
  const raw=await req.text();if(raw.length>32768)throw Error('Invalid request');
  const params=new URLSearchParams(raw),fields:Record<string,string>={};for(const[k,v]of params){if(k in fields)throw Error('Duplicate field');fields[k]=v;}
  const data=await verifyNotification(fields,paymentConfiguration(env));
  await rpc('shop_apply_payment',{p_trade:data.trade_no,p_amount:data.amount,p_gateway_trade:data.gateway_trade_no,p_environment:data.environment,p_simulated:data.simulated,p_success:data.success});
  return new Response('1|OK',{headers:{'Content-Type':'text/plain'}});
 }catch(_){return new Response('0|Verification failed',{status:400,headers:{'Content-Type':'text/plain'}});}
}
Deno.serve(async(req:Request)=>{
 if(new URL(req.url).pathname.endsWith('/notify'))return notification(req);
 if(req.headers.get('origin')!==origin||!/^https:\/\//.test(origin))return json({error:'Origin not allowed'},403);
 if(req.method==='OPTIONS')return json({ok:true});
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 try{
  const raw=await req.text();if(raw.length>12000)return json({error:'Request too large'},413);
  const body=JSON.parse(raw),action=body.action;
  if(action==='config')return json({enabled:env('SHOP_ENABLED')==='true',mode:env('ECPAY_MODE')||'test',siteKey:env('SHOP_TURNSTILE_SITE_KEY')});
  if(['list','approve','cancel','manual_payment','fulfill'].includes(action)){
   await admin(req);
   if(action==='list'){
    const rows=await request('/rest/v1/shop_orders?select=id,order_no,customer,items,subtotal,shipping_fee,payment,status,environment,created_at,updated_at&order=created_at.desc&limit=50');return json({rows});
   }
   if(!/^[0-9a-f-]{36}$/i.test(body.id)||typeof body.version!=='string')throw Error('Invalid order reference');
   if(action==='approve'&&env('SHOP_ENABLED')!=='true')throw Error('Ordering is not enabled');
   if(action==='approve')return json(publicOrder(await rpc('shop_approve',{p_id:body.id,p_version:body.version,p_shipping:Number(body.shipping_fee)})));
   if(action==='cancel')return json(publicOrder(await rpc('shop_cancel',{p_id:body.id,p_version:body.version})));
   if(action==='manual_payment')return json(publicOrder(await rpc('shop_manual_payment',{p_id:body.id,p_version:body.version,p_reference:String(body.reference||'')})));
   return json(publicOrder(await rpc('shop_fulfill',{p_id:body.id,p_version:body.version})));
  }
  if(action==='status')return json(publicOrder(await owned(String(body.id),String(body.token))));
  if(env('SHOP_ENABLED')!=='true')return json({error:'購物服務尚未開放'},503);
  const payment=paymentConfiguration(env);
  if(action==='create'){
   // Live requests require verified anti-bot protection; test creates require an administrator.
   if(payment.mode==='test')await admin(req);
   else{
    if(!env('SHOP_TURNSTILE_SECRET')||!env('SHOP_IP_HASH_SALT'))throw Error('Ordering protection not configured');
    const check=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:new URLSearchParams({secret:env('SHOP_TURNSTILE_SECRET'),response:String(body.captcha||'')}),signal:AbortSignal.timeout(10000)});
    const verified=await check.json();if(!verified.success||verified.hostname!==new URL(origin).hostname)throw Error('Please complete verification');
   }
   if(!/^[0-9a-f-]{36}$/i.test(body.key)||!(/^[0-9a-f]{64}$/).test(body.token))throw Error('Invalid request token');
   if(!Array.isArray(body.cart)||body.cart.length<1||body.cart.length>20)throw Error('Invalid cart');
   const cart=body.cart.map((x:any)=>({id:String(x.id||''),qty:Number(x.qty)}));
   if(cart.some((x:any)=>!x.id||x.id.length>160||!Number.isInteger(x.qty)||x.qty<1||x.qty>99))throw Error('Invalid cart');
   const contact=customer(body.customer),ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
   const row=await rpc('shop_submit',{p_key:body.key,p_token_hash:await sha256(body.token),p_request_hash:await sha256(JSON.stringify({customer:contact,cart})),p_ip_hash:await sha256(env('SHOP_IP_HASH_SALT')+':'+ip),p_customer:contact,p_cart:cart,p_environment:payment.mode});
   return json(publicOrder(row));
  }
  if(action==='pay'){
   const row=await owned(String(body.id),String(body.token));if(row.environment!==payment.mode)throw Error('Payment environment mismatch');
   // Validate signing configuration and return URLs before consuming the one-time payment start.
   const back=new URL(env('SHOP_BACK_URL'));if(back.origin!==origin||back.protocol!=='https:')throw Error('Invalid return URL');
   const notify=project+'/functions/v1/shop-checkout/notify';
   const started=await rpc('shop_start_payment',{p_id:row.id,p_token_hash:await sha256(String(body.token))});
   return json({action:payment.action,fields:await paymentFields(started,payment,notify,back.href)});
  }
  return json({error:'Unknown action'},400);
 }catch(e){
  const message=String((e as Error)?.message||'Operation failed');
  const translated=/Admin/.test(message)?'請先以管理員登入後台再測試':/version conflict/.test(message)?'資料已有更新，請重新載入核對':/insufficient.*stock|unavailable/.test(message)?'商品供貨狀態已變更，請重新確認':/price changed/.test(message)?'商品價格已更新，請客人重新確認訂購內容':/payment already/.test(message)?'這張單據已開始付款，請先查詢進度或聯絡店家，勿重複付款':/too many/.test(message)?'操作較頻繁，請稍後再試':'本次操作未完成，請重新查詢進度後再試；如已付款請聯絡店家核對。';
  return json({error:translated},/Admin/.test(message)?403:400);
 }
});
