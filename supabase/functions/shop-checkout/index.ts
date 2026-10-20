import {sha256,hmac,issueChallenge,verifyChallenge,customer,cart,publicOrder} from './manual.mjs';
const env=(key:string)=>Deno.env.get(key)||'';
const project=env('SUPABASE_URL');
const secret=env('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(env('SUPABASE_SECRET_KEYS')||'{}').default||'';
const anon=env('SUPABASE_ANON_KEY')||JSON.parse(env('SUPABASE_PUBLISHABLE_KEYS')||'{}').default||'';
const origin=env('SHOP_ORIGIN')||'https://taurus850426-design.github.io';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'content-type,authorization,apikey','Access-Control-Allow-Methods':'POST,OPTIONS','Cache-Control':'no-store','Vary':'Origin'}});}
async function request(path:string,options:RequestInit={}){
 const response=await fetch(project+path,{...options,headers:{apikey:secret,...(secret.startsWith('eyJ')?{Authorization:'Bearer '+secret}:{}),'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('Database operation failed: '+(await response.text()).slice(0,500));
 return response.status===204?null:await response.json();
}
const rpc=(name:string,args:unknown={})=>request('/rest/v1/rpc/'+name,{method:'POST',body:JSON.stringify(args)});
async function admin(req:Request){
 const auth=req.headers.get('Authorization')||'';if(!/^Bearer .+/.test(auth))throw Error('Admin sign-in required');
 const response=await fetch(project+'/auth/v1/user',{headers:{apikey:anon,Authorization:auth},signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Admin sign-in required');const user=await response.json();
 if(!uuid.test(user.id))throw Error('Admin sign-in required');
 const rows=await request('/rest/v1/profiles?id=eq.'+user.id+'&select=role,enabled');
 if(rows[0]?.role!=='admin'||rows[0]?.enabled!==true)throw Error('Admin permission required');
}
async function owned(id:unknown,token:unknown){
 if(typeof id!=='string'||!uuid.test(id)||typeof token!=='string'||!/^[0-9a-f]{64}$/.test(token))throw Error('Request not found');
 const rows=await request('/rest/v1/shop_orders?id=eq.'+id+'&token_hash=eq.'+await sha256(token)+'&select=*');if(!rows.length)throw Error('Request not found');return rows[0];
}
async function readBody(req:Request){
 const reader=req.body?.getReader();if(!reader)throw Error('Invalid request');let size=0;const chunks:Uint8Array[]=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16000){await reader.cancel();throw Error('Request too large');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
Deno.serve(async(req:Request)=>{
 // Card initiation and all old gateway callbacks stay disabled, regardless of environment secrets.
 if(new URL(req.url).pathname.endsWith('/notify'))return json({error:'信用卡服務未啟用'},410);
 if(req.headers.get('origin')!==origin)return json({error:'Origin not allowed'},403);
 if(req.method==='OPTIONS')return json({ok:true});
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 try{
  const body=await readBody(req),action=body?.action;
  if(!secret||!project)throw Error('Service not configured');
  if(action==='pay')return json({error:'目前僅提供銀行轉帳與到店付款，刷卡未啟用'},410);
  if(['list','approve','cancel','manual_payment','fulfill'].includes(action)){
   await admin(req);await rpc('shop_expire_unpaid');
   if(action==='list'){
    const page=Math.max(0,Math.min(1000,Math.floor(Number(body.page)||0)));
    const rows=await request('/rest/v1/shop_orders?select=id,order_no,customer,items,subtotal,shipping_fee,payment,status,environment,customer_message,hold_until,transfer_last5,created_at,updated_at&order=created_at.desc,id.desc&limit=26&offset='+page*25);
    return json({rows:rows.slice(0,25),hasMore:rows.length>25,page});
   }
   if(!uuid.test(body.id)||typeof body.version!=='string')throw Error('Invalid order reference');
   if(action==='approve'){
    const settings=await request('/rest/v1/shop_settings?singleton=eq.true&select=enabled');if(settings[0]?.enabled!==true)throw Error('Ordering is not enabled');
    const fee=Number(body.shipping_fee);if(!Number.isInteger(fee)||fee<0||fee>10000)throw Error('Invalid shipping fee');
    return json(publicOrder(await rpc('shop_approve_manual',{p_id:body.id,p_version:body.version,p_shipping:fee,p_message:String(body.message||'')})));
   }
   if(action==='cancel')return json(publicOrder(await rpc('shop_cancel',{p_id:body.id,p_version:body.version})));
   if(action==='manual_payment')return json(publicOrder(await rpc('shop_manual_payment',{p_id:body.id,p_version:body.version,p_reference:String(body.reference||'')})));
   return json(publicOrder(await rpc('shop_fulfill',{p_id:body.id,p_version:body.version})));
  }
  if(['status','recover','report_transfer','catalog'].includes(action))await rpc('shop_expire_unpaid');
  if(action==='recover'){
   if(!uuid.test(body.key)||typeof body.token!=='string'||!/^[0-9a-f]{64}$/.test(body.token))throw Error('Request not found');
   const rows=await request('/rest/v1/shop_orders?request_key=eq.'+body.key+'&token_hash=eq.'+await sha256(body.token)+'&select=*');
   if(!rows.length)throw Error('Request not found');return json(publicOrder(rows[0]));
  }
  if(action==='status')return json(publicOrder(await owned(body.id,body.token)));
  if(action==='report_transfer'){
   const row=await owned(body.id,body.token);return json(publicOrder(await rpc('shop_report_transfer',{p_id:row.id,p_token_hash:await sha256(body.token),p_last5:String(body.last5||'')})));
  }
  const settings=await request('/rest/v1/shop_settings?singleton=eq.true&select=enabled');
  const ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||req.headers.get('cf-connecting-ip')||'unknown';
  const ipHash=await hmac(secret,'dk-shop-ip:'+ip);
  if(action==='config')return json({enabled:settings[0]?.enabled===true,mode:'manual',payments:['transfer','store'],challenge:await issueChallenge(secret,ipHash)});
  if(action==='catalog')return json({items:await rpc('shop_catalog')});
  if(settings[0]?.enabled!==true)return json({error:'購物服務暫停接單，請透過官方 LINE 聯絡'},503);
  if(action==='create'){
   if(body.website||body.consent!==true||!await verifyChallenge(body.challenge,secret,ipHash))return json({error:'驗證已失效或尚未完成，請重新整理後再送出；購物車已保留'},400);
   if(!uuid.test(body.key)||typeof body.token!=='string'||!/^[0-9a-f]{64}$/.test(body.token))throw Error('Invalid request token');
   const contact=customer(body.customer),lines=cart(body.cart);
   await rpc('shop_expire_unpaid');
   const row=await rpc('shop_submit',{p_key:body.key,p_token_hash:await sha256(body.token),p_request_hash:await sha256(JSON.stringify({customer:contact,cart:lines})),p_ip_hash:ipHash,p_customer:contact,p_cart:lines,p_environment:'live'});
   return json(publicOrder(row));
  }
  return json({error:'Unknown action'},400);
 }catch(e){
  const message=String((e as Error)?.message||'Operation failed');
  const translated=/Admin/.test(message)?'請先以管理員登入後台':/version conflict/.test(message)?'資料已有更新，請重新載入核對':/insufficient.*stock|product unavailable/.test(message)?'商品供貨狀態已變更，請更新商品後重新確認':/price changed/.test(message)?'商品價格已更新，請客人重新確認訂購內容':/too many/.test(message)?'送單較頻繁，請稍後再試或聯絡官方 LINE':/not found/.test(message)?'查不到這筆訂購，請確認完整查單連結':/instructions required/.test(message)?'請填寫客人可見的付款／取貨說明（5至2000字）':/Invalid contact|Invalid cart|invalid quantity|invalid customer|Invalid shipping|Invalid request token/.test(message)?'資料不完整或格式錯誤，請重新核對':'本次操作未完成，請重新查詢進度；如已轉帳請先聯絡店家，勿重複付款。';
  return json({error:translated},/Admin/.test(message)?403:400);
 }
});
