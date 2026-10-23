import './policy.js';
import {clean,queryKey,research,boundedJson} from './research.mjs';
const env=(k:string)=>Deno.env.get(k)||'';
const policy=(globalThis as any).DKBuilderPolicy;
const origins=['https://taurus850426-design.github.io','https://dkcomputer.com.tw','https://www.dkcomputer.com.tw'];
const root=env('SUPABASE_URL'),service=env('SUPABASE_SERVICE_ROLE_KEY');
const dbHeaders={apikey:service,Authorization:'Bearer '+service,'Content-Type':'application/json'};
async function db(path:string,method='GET',body?:unknown){return boundedJson(await fetch(root+'/rest/v1/'+path,{method,headers:{...dbHeaders,Prefer:'return=representation'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)}));}
const rpc=(name:string,args:unknown)=>db('rpc/'+name,'POST',args);
async function sha(s:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
async function resolveQuery(q:string,kind:string,clientHash:string,refresh=false){
 const key=queryKey(q,kind),cached=(await db('builder_research_cache?cache_key=eq.'+encodeURIComponent(key)+'&select=payload,expires_at,checked_at&limit=1'))[0];
 if(cached&&!refresh&&Date.parse(cached.expires_at)>Date.now())return {...cached.payload,cached:true,stale:false};
 if(!env('BUILDER_BRAVE_API_KEY')||!env('BUILDER_OPENAI_API_KEY'))return {candidates:cached?.payload?.candidates||[],cached:!!cached,stale:!!cached,status:'not_configured'};
 const reservation=await rpc('builder_reserve_research',{p_key:key,p_client:clientHash});
 if(!reservation.allowed)return {candidates:cached?.payload?.candidates||[],cached:!!cached,stale:!!cached,status:reservation.reason};
 try{
  const candidates=await research(q,kind,{braveKey:env('BUILDER_BRAVE_API_KEY'),openaiKey:env('BUILDER_OPENAI_API_KEY'),policy});
  if(cached?.payload?.candidates?.some((r:any)=>r.profile)&&!candidates.some((r:any)=>r.profile)){await rpc('builder_finish_research',{p_id:reservation.id,p_payload:null,p_success:false});return {...cached.payload,cached:true,stale:true,status:'update_incomplete'};}
  const payload={candidates,status:candidates.length?'ok':'not_found',policyVersion:policy.version};
  await rpc('builder_finish_research',{p_id:reservation.id,p_payload:payload,p_success:true});
  return {...payload,cached:false,stale:false};
 }catch{
  // Retain the reserved upper cost even for provider failure/timeout; never refund an uncertain bill.
  await rpc('builder_finish_research',{p_id:reservation.id,p_payload:null,p_success:false}).catch(()=>{});
  return {candidates:cached?.payload?.candidates||[],cached:!!cached,stale:!!cached,status:'temporarily_unavailable'};
 }
}
export async function handler(req:Request){
 const origin=req.headers.get('origin')||'',allowed=origins.includes(origin)||!!env('BUILDER_DEV_ORIGIN')&&env('BUILDER_DEV_ORIGIN')===origin;
 const headers={'Content-Type':'application/json','Vary':'Origin',...(allowed?{'Access-Control-Allow-Origin':origin}:{}),'Access-Control-Allow-Headers':'content-type, apikey, authorization','Access-Control-Allow-Methods':'POST, OPTIONS'};
 const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
 if(req.method==='OPTIONS')return new Response(null,{status:allowed?204:403,headers});
 if(req.method!=='POST')return json({error:'method'},405);
 const cron=!!env('BUILDER_CRON_TOKEN')&&req.headers.get('authorization')==='Bearer '+env('BUILDER_CRON_TOKEN');
 if(!allowed&&!cron)return json({error:'origin'},403);
 try{
  if(Number(req.headers.get('content-length')||0)>2048)return json({error:'size'},413);
  let input;try{input=await boundedJson(new Response(req.body),2048);}catch(error){return json({error:'body'},String(error).includes('provider_size')?413:400);}
  if(!input||typeof input!=='object'||Array.isArray(input))return json({error:'body'},400);
  if(input.action==='catalog'){const rows=await db('builder_research_cache?select=payload,checked_at,expires_at&order=checked_at.desc&limit=100');return json({profiles:rows.filter((r:any)=>Date.parse(r.expires_at)>Date.now()).flatMap((r:any)=>r.payload.candidates||[]).map((r:any)=>r.profile).filter(Boolean)});}
  if(input.action==='refresh'){
   if(!cron)return json({error:'forbidden'},403);
   const rows=await db('builder_research_cache?expires_at=lt.'+encodeURIComponent(new Date().toISOString())+'&order=checked_at.asc&limit=3&select=cache_key,query,kind');
   const states=await Promise.all(rows.map(async(r:any)=>(await resolveQuery(r.query,r.kind,'cron',true)).status));
   await db('builder_research_runs','POST',{kind:'daily-refresh',count:rows.length,status:states.join(',')||'nothing_due'});
   return json({checked:rows.length,states});
  }
  if(input.action==='usage'){
   if(!cron){
    const auth=req.headers.get('authorization')||'';if(!auth.startsWith('Bearer '))return json({error:'unauthenticated'},401);
    let user;try{user=await boundedJson(await fetch(root+'/auth/v1/user',{headers:{apikey:service,Authorization:auth},signal:AbortSignal.timeout(8000)}));}catch{return json({error:'unauthenticated'},401);}
    if(!user.id||!/^[a-f0-9-]{36}$/i.test(user.id))return json({error:'unauthenticated'},401);
    const profile=(await db('profiles?id=eq.'+encodeURIComponent(user.id)+'&select=role,enabled&limit=1'))[0];
    if(!profile?.enabled||profile.role!=='admin')return json({error:'forbidden'},403);
   }
   return json({ok:true,usage:await rpc('builder_research_usage',{})});
  }
  const q=clean(input.query),kind=input.kind;if(q.length<2||!['game','software'].includes(kind))return json({error:'query'},400);
  // Platform-provided client IP; hash with a server secret, never store raw IP or customer details.
  const ip=req.headers.get('x-forwarded-for')?.split(',')[0].trim();
  if(!env('BUILDER_RATE_SALT')||!ip)return json({candidates:[],status:'not_configured'});
  const clientHash=await sha(env('BUILDER_RATE_SALT')+':'+ip);
  return json(await resolveQuery(q,kind,clientHash));
 }catch{return json({candidates:[],status:'temporarily_unavailable'},503);}
}
Deno.serve(handler);
