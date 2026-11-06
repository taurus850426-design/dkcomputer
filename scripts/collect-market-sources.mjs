import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { SOURCES, parseSource } from './market-source-collectors.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const out = path.resolve(root,process.env.DK_MARKET_OUTPUT || 'data/market-sources');
await fs.mkdir(out,{recursive:true});
const health = {schemaVersion:1,attemptedAt:new Date().toISOString(),sources:{}};
for (const [source,url] of Object.entries(SOURCES)) {
  try {
    const response = await fetch(url,{signal:AbortSignal.timeout(25000),headers:{'User-Agent':'DKComputer-PriceMonitor/1.0','Accept':'text/html'}});
    if (!response.ok) throw Error('HTTP '+response.status);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 5000000) throw Error('response_too_large');
    const charset = response.headers.get('content-type')?.match(/charset=([\w-]+)/i)?.[1] || (source==='coolpc'?'big5':'utf-8');
    const feed = parseSource(source,new TextDecoder(charset).decode(buffer));
    const target = path.join(out,source+'.json.gz');
    try {
      const { gunzipSync } = await import('node:zlib');
      const prior = JSON.parse(gunzipSync(await fs.readFile(target)));
      if (feed.products.length < prior.products.length*0.7) throw Error('product_count_drop_over_30_percent');
    } catch (e) { if (e.code!=='ENOENT') throw e; }
    await fs.writeFile(target+'.tmp',gzipSync(JSON.stringify(feed)+'\n'));
    await fs.rename(target+'.tmp',target);
    health.sources[source]={ok:true,count:feed.products.length,capturedAt:feed.capturedAt,file:source+'.json.gz'};
  } catch (e) {
    let lastGoodRetained=false;
    try { await fs.access(path.join(out,source+'.json.gz')); lastGoodRetained=true; } catch (_) {}
    health.sources[source]={ok:false,error:e.message,lastGoodRetained};
  }
}
await fs.writeFile(path.join(out,'health.json.tmp'),JSON.stringify(health,null,2)+'\n');
await fs.rename(path.join(out,'health.json.tmp'),path.join(out,'health.json'));
console.log(JSON.stringify(health));
if (Object.values(health.sources).some(x=>!x.ok)) process.exitCode=2;
