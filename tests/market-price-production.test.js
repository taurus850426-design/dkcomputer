'use strict';
const assert=require('assert'),fs=require('fs'),e=require('../market-price-engine.js');
assert.equal(e.normalizeQuote({source:'autobuy',name:'RTX 5060 裝機配',price:9990}).eligible,false);
assert.equal(e.normalizeQuote({source:'sinya',name:'RTX 5060',price:9990,priceLabel:'搭機價'}).eligible,false);
const cfg=fs.readFileSync('.github/workflows/market-price-update.yml','utf8');
assert(cfg.includes('schedule:'));assert(cfg.includes('scripts/update-market-prices.js'));
console.log('production market pricing checks passed');
