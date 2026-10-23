(function(){
 'use strict';
 const pending=new Map();
 async function search(query,kind){
  if(window.DKBuilderServiceConfig?.enabled!==true)return {candidates:[],status:'not_configured'};
  const key=kind+':'+query.trim().toLowerCase();if(pending.has(key))return pending.get(key);
  const task=(async()=>{try{
   const base=typeof SUPABASE_URL==='string'?SUPABASE_URL:'',anon=typeof SUPABASE_ANON_KEY==='string'?SUPABASE_ANON_KEY:'';
   if(!base||!anon)return {candidates:[],status:'not_configured'};
   const r=await fetch(base+'/functions/v1/builder-research',{method:'POST',headers:{'Content-Type':'application/json',apikey:anon},body:JSON.stringify({query,kind}),signal:AbortSignal.timeout(70000)});
   if(!r.ok)throw Error();const data=await r.json();if(!Array.isArray(data.candidates))throw Error();return data;
  }catch{return {candidates:[],status:'temporarily_unavailable'};}finally{pending.delete(key);}})();pending.set(key,task);return task;
 }
 window.DKBuilderResearch={search,async catalog(){if(window.DKBuilderServiceConfig?.enabled!==true)return [];try{const base=typeof SUPABASE_URL==='string'?SUPABASE_URL:'';if(!base)return [];const r=await fetch(base+'/functions/v1/builder-research',{method:'POST',headers:{'Content-Type':'application/json',apikey:typeof SUPABASE_ANON_KEY==='string'?SUPABASE_ANON_KEY:''},body:JSON.stringify({action:'catalog'}),signal:AbortSignal.timeout(6000)});if(!r.ok)return [];const d=await r.json();return Array.isArray(d.profiles)?d.profiles:[];}catch{return [];}}};
})();
