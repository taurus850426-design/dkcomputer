import {boundedJson,clean} from './research.mjs';
export function steamId(url){try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='store.steampowered.com'?u.pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1]||'':'';}catch{return '';}}
function plain(html){return String(html||'').replace(/<br\s*\/?\s*>|<\/li>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&(?:nbsp|reg|trade);|[®™]/g,' ').replace(/&amp;/g,'&').replace(/[ \t]+/g,' ').trim();}
export function steamRequirements(data,id){
 const a=data?.[id]?.data;if(!data?.[id]?.success||!a||!['game','software'].includes(a.type)||!a.platforms?.windows)return null;
 const level=a.pc_requirements?.recommended?'recommended':'minimum',text=plain(a.pc_requirements?.[level]);
 const line=(label)=>text.split('\n').find(s=>s.trim().toLowerCase().startsWith(label.toLowerCase()+':'))?.split(':').slice(1).join(':').trim()||'';
 const memory=line('Memory').match(/(\d+(?:\.\d+)?)\s*GB/i),storage=line('Storage').match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
 return {name:clean(a.name),kind:a.type==='game'?'game':'software',version:'Steam app '+id,sourceUrl:'https://store.steampowered.com/app/'+id+'/',cpu:clean(line('Processor'),180),gpu:clean(line('Graphics'),180),ramGB:memory?Number(memory[1]):0,storageGB:storage?Math.ceil(Number(storage[1])/(storage[2].toUpperCase()==='MB'?1000:1)):0,requirementLevel:level,checkedAt:new Date().toISOString()};
}
export async function fetchSteam(url,fetchImpl=fetch){const id=steamId(url);if(!id)return null;const data=await boundedJson(await fetchImpl('https://store.steampowered.com/api/appdetails?appids='+id+'&l=english',{signal:AbortSignal.timeout(10000)}),400000);return steamRequirements(data,id);}
