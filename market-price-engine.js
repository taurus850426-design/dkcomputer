(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DKMarketPrice=api;})(typeof window==='object'?window:globalThis,function(){'use strict';
const SOURCE_IDS=new Set(['coolpc','sinya','autobuy']);
const PROMO=/搭機|搭板|任搭|限搭|組裝價|會員價|限時|特價|活動|贈品|折價|優惠|現省|原價\s*[$＄]|coupon|combo/i;
function cleanText(v){return String(v??'').replace(/\s+/g,' ').trim();}
function normalizeModel(v){return cleanText(v).toUpperCase().replace(/[™®]/g,'').replace(/[^A-Z0-9]+/g,' ').trim();}
function normalizeQuote(raw){
 const source=cleanText(raw?.source).toLowerCase(),name=cleanText(raw?.name),model=normalizeModel(raw?.model||name),price=Number(raw?.price),label=cleanText(raw?.priceLabel||raw?.note);
 const validSource=SOURCE_IDS.has(source),validPrice=Number.isFinite(price)&&price>0,promoText=[name,label].filter(Boolean).join(' ');
 return {source,name,model,price,priceLabel:label,url:cleanText(raw?.url),capturedAt:cleanText(raw?.capturedAt),eligible:validSource&&validPrice&&!!model&&!PROMO.test(promoText),reason:!validSource?'unknown_source':!validPrice?'invalid_price':!model?'missing_model':PROMO.test(promoText)?'conditional_price':''};
}
function median(values){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function groupQuotes(rows){const groups=new Map();for(const raw of rows||[]){const q=normalizeQuote(raw);if(!q.model)continue;if(!groups.has(q.model))groups.set(q.model,[]);groups.get(q.model).push(q);}return groups;}
function evaluate(rows,previousPrice=null,opts={}){
 const quotes=(rows||[]).map(normalizeQuote),eligible=quotes.filter(q=>q.eligible),bySource=new Map();for(const q of eligible){const old=bySource.get(q.source);if(!old||q.price<old.price)bySource.set(q.source,q);}
 const used=[...bySource.values()],marketPrice=median(used.map(q=>q.price)),minSources=opts.minSources??2,maxChange=opts.maxChange??0.20;
 let status='ok',reason='';if(used.length<minSources){status='hold';reason='insufficient_sources';}
 if(status==='ok'&&Number.isFinite(previousPrice)&&previousPrice>0&&Math.abs(marketPrice-previousPrice)/previousPrice>maxChange){status='hold';reason='abnormal_change';}
 return {status,reason,marketPrice:status==='ok'?marketPrice:previousPrice,observedMedian:marketPrice,sourceCount:used.length,usedSources:used.map(q=>q.source),quotes};
}
function dkPrice(marketPrice,cost=null,opts={}){
 if(!Number.isFinite(marketPrice)||marketPrice<=0)return null;const floor=Number.isFinite(cost)&&cost>0?cost*(1+(opts.minMarginRate??0)):0;const step=opts.roundStep??10;return Math.ceil(Math.max(marketPrice,floor)/step)*step;
}
return {normalizeModel,normalizeQuote,groupQuotes,evaluate,dkPrice};});