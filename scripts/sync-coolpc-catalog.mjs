/** Manual refresh: one request, validate before atomic replacement. Never runs on visitor requests. */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCatalog,SOURCE_URL } from './coolpc-catalog.mjs';
const root=new URL('../',import.meta.url);
const fixture=process.argv.indexOf('--input');
let html,retrievedAt=new Date().toISOString();
if(fixture>=0){html=await fs.readFile(process.argv[fixture+1],'utf8');retrievedAt=(await fs.stat(process.argv[fixture+1])).mtime.toISOString();}
else{
 const response=await fetch(SOURCE_URL,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'DKComputer-CatalogReview/1.0','Accept':'text/html'}});
 if(!response.ok)throw Error('來源無法讀取：'+response.status);
 const buffer=await response.arrayBuffer();if(buffer.byteLength>4000000)throw Error('來源過大');
 const charset=(response.headers.get('content-type')||'').match(/charset=([\w-]+)/i)?.[1]||'big5';html=new TextDecoder(charset).decode(buffer);
}
const overrides=JSON.parse(await fs.readFile(new URL('data/builder-overrides.json',root),'utf8'));
const data=parseCatalog(html,overrides);data.updatedAt=retrievedAt;const target=new URL('data/builder-catalog.json',root);
try{const prior=JSON.parse(await fs.readFile(target,'utf8'));if(data.products.length<prior.products.length*0.7)throw Error('商品減少超過 30%，需人工檢查；保留既有資料');}catch(e){if(e.code!=='ENOENT')throw e;}
const temp=fileURLToPath(target)+'.tmp';await fs.writeFile(temp,JSON.stringify(data)+'\n');await fs.rename(temp,target);
console.log(JSON.stringify({products:data.products.length,categories:data.categories.length,excluded:data.excluded,updatedAt:data.updatedAt}));
