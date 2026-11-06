const assert=require('assert');const p=require('../market-price-pipeline.js');
assert.equal(p.compatible({brand:'Kingston',name:'KC3000 1TB'},{brand:'Kingston',name:'KC3000 1TB'}),true);
assert.equal(p.compatible({brand:'Kingston',name:'KC3000 1TB'},{brand:'Kingston',name:'KC3000 2TB'}),false);
assert.equal(p.compatible({brand:'MSI',name:'RTX 5070 GAMING OC'},{brand:'ASUS',name:'RTX 5070 GAMING OC'}),false);
const out=p.priceCatalog([{id:'x',brand:'Kingston',name:'Kingston KC3000 1TB',price:3000}],[
 {source:'coolpc',brand:'Kingston',name:'Kingston KC3000 1TB',price:3100,priceLabel:'一般售價'},
 {source:'sinya',brand:'Kingston',name:'Kingston KC3000 1TB',price:3200,priceLabel:'售價'},
 {source:'autobuy',brand:'Kingston',name:'Kingston KC3000 2TB',price:5000,priceLabel:'售價'}
]);
assert.equal(out[0].market.sourceCount,2);assert.equal(out[0].price,3100);
console.log('market-price-pipeline tests passed');