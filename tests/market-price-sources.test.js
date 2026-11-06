const assert=require('assert');const s=require('../market-price-sources.js');
const rows=s.combine([{schemaVersion:1,source:'sinya',capturedAt:'2026-11-06T17:00:00+08:00',products:[{brand:'Kingston',model:'KC3000 1TB',price:6488,priceLabel:'一般售價'}]}]);
assert.equal(rows.length,1);assert.equal(rows[0].source,'sinya');assert.equal(rows[0].price,6488);
assert.throws(()=>s.validateFeed({schemaVersion:1,source:'unknown',products:[]}),/invalid_feed/);
console.log('market-price-sources tests passed');