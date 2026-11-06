'use strict';
const fs=require('fs'),engine=require('../market-price-engine.js'),pipeline=require('../market-price-pipeline.js');
const SOURCES=[{id:'coolpc',url:'https://www.coolpc.com.tw/evaluate.php'},{id:'sinya',url:'https://www.sinya.com.tw/diy/?quick=1'},{id:'autobuy',url:'https://www.autobuy.tw/diy'}];
const UA='Mozilla/5.0 (compatible; DKComputer-MarketMonitor/1.0)';
const PROMO=/搭機|搭板|裝機配|任搭|限搭|組裝價|會員價|限時|特價|活動|贈品|折價|優惠|現省|下殺|coupon|combo/i;
function plain(html){return html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();}
function extract(source,html,catalog){
 const body=plain(html),upper=body.toUpperCase(),rows=[];
 for(const item of catalog){
  const toks=engine.normalizeModel(item.name||'').split(' ').filter(x=>x.length>=4).slice(0,6);
  let pos=-1; for(const t of toks){const p=upper.indexOf(t);if(p>=0&&(pos<0||p<pos))pos=p;}
  if(pos<0)continue;
  const win=body.slice(Math.max(0,pos-120),pos+520); if(PROMO.test(win))continue;
  const prices=[...win.matchAll(/(?:NT\$|NTD|\$|＄)?\s*([1-9]\d{2,6})(?!\d)/g)].map(m=>Number(m[1])).filter(n=>n>=100&&n<=500000);
  const base=Number(item.price)||0, plausible=prices.filter(n=>!base||(n>=base*.45&&n<=base*1.8)); if(!plausible.length)continue;
  plausible.sort((a,b)=>Math.abs(a-base)-Math.abs(b-base));
  rows.push({source:source.id,name:item.name,model:item.name,price:plausible[0],priceLabel:'normal public price',url:source.url,capturedAt:new Date().toISOString()});
 }
 return rows;
}
(async()=>{
 const raw=JSON.parse(fs.readFileSync('data/builder-catalog.json','utf8')),catalog=raw.products||[],quotes=[],health={};
 for(const s of SOURCES){try{const r=await fetch(s.url,{headers:{'user-agent':UA,'accept-language':'zh-TW,zh;q=0.9'}});if(!r.ok)throw new Error('HTTP '+r.status);const rows=extract(s,await r.text(),catalog);quotes.push(...rows);health[s.id]={ok:true,count:rows.length,http:r.status};}catch(e){health[s.id]={ok:false,count:0,error:String(e.message||e)};}}
 const out={schemaVersion:1,generatedAt:new Date().toISOString(),health,products:{}};
 for(const item of catalog){const m=pipeline.matchCatalogItem(item,quotes),ev=engine.evaluate(m.matched,Number(item.price)||null,{minSources:2,maxChange:.20});if(ev.status!=='ok')continue;const price=engine.dkPrice(ev.marketPrice,Number(item.cost)||null,{minMarginRate:0,roundStep:10});if(price)out.products[item.id]={price,marketMedian:ev.observedMedian,sourceCount:ev.sourceCount,sources:ev.usedSources};}
 fs.writeFileSync('data/dk-market-prices.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({health,priced:Object.keys(out.products).length}));
 if(Object.values(health).filter(x=>x.ok).length<2)process.exitCode=2;
})().catch(e=>{console.error(e);process.exit(1)});