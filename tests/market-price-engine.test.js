const assert=require('assert');const e=require('../market-price-engine.js');
const now='2026-11-06T17:00:00+08:00';
let r=e.evaluate([
 {source:'coolpc',model:'RTX 5070 GAMING',price:15990,priceLabel:'一般售價',capturedAt:now},
 {source:'sinya',model:'RTX-5070 GAMING',price:16290,priceLabel:'售價',capturedAt:now},
 {source:'autobuy',model:'RTX 5070 GAMING',price:16190,priceLabel:'售價',capturedAt:now}
],16000);
assert.equal(r.status,'ok');assert.equal(r.sourceCount,3);assert.equal(r.marketPrice,15990);assert.equal(r.referenceSource,'coolpc');
r=e.evaluate([{source:'coolpc',model:'X',price:9990,priceLabel:'限搭機價'},{source:'sinya',model:'X',price:12000,priceLabel:'一般售價'}],11800);
assert.equal(r.status,'hold');assert.equal(r.reason,'missing_coolpc_reference');assert.equal(r.marketPrice,11800);
r=e.evaluate([{source:'coolpc',model:'X',price:7000},{source:'sinya',model:'X',price:7100},{source:'autobuy',model:'X',price:7200}],10000);
assert.equal(r.status,'hold');assert.equal(r.reason,'abnormal_change');assert.equal(r.marketPrice,10000);
assert.equal(e.dkPrice(16190,17000,{minMarginRate:.05,roundStep:10}),17850);
assert.equal(e.normalizeModel('Kingston KC3000-1TB'),'KINGSTON KC3000 1TB');
console.log('market-price-engine tests passed');
let promoName=e.normalizeQuote({source:'autobuy',name:'【搭板】Kingston DDR5-5600 16G',price:7999,priceLabel:'售價'});assert.equal(promoName.eligible,false);assert.equal(promoName.reason,'conditional_price');
let bundle=e.normalizeQuote({source:'autobuy',name:'☆裝機配★ i5-12400+主機板+UMAX DDR4-3200 16G',price:13188,priceLabel:'售價'});assert.equal(bundle.eligible,false);
