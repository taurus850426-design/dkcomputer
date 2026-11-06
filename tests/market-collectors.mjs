import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSource} from '../scripts/market-source-collectors.mjs';
test('AUTOBUY requires two agreeing price fields, rejects bundles and does not read model digits',()=>{
 const html='<select class="diy_products"><optgroup label="CPU"><option name="5680" value="393996">Intel Core Ultra 5 225 10核 3.3Ghz ☆5680元</option><option name="5280" value="414656">【搭板】Intel Core Ultra 5 225 ☆5280元</option><option name="5060" value="99">RTX 5060 ☆9990元</option><option value="88">RTX 5090 32GB</option></optgroup></select>';
 const feed=parseSource('autobuy',html,'2026-11-06T16:00:00Z');
 assert.equal(feed.products.length,1);assert.equal(feed.products[0].price,5680);assert.equal(feed.products[0].sourceProductId,'393996');
 assert.throws(()=>parseSource('autobuy','<h1>503 retry</h1>'),/no_verified/);
});
test('conditional optgroup and disabled rows cannot enter the feed',()=>{
 assert.throws(()=>parseSource('autobuy','<select class="diy_products"><optgroup label="組合價"><option name="1000" value="1">SSD ☆1000元</option></optgroup><option disabled name="2000" value="2">SSD ☆2000元</option></select>'),/no_verified/);
});
test('Sinya accepts explicit single TWD Offer only; error pages and aggregate teaser prices fail closed',()=>{
 const html=v=>'<script type="application/ld+json">'+JSON.stringify(v)+'</script>';
 const product={'@type':'Product',name:'Kingston SSD 1TB',sku:'42',offers:{'@type':'Offer',price:'2000',priceCurrency:'TWD',url:'https://www.sinya.com.tw/product/42'}};
 assert.equal(parseSource('sinya',html(product)).products[0].price,2000);
 assert.throws(()=>parseSource('sinya',html({...product,offers:{'@type':'AggregateOffer',lowPrice:100}})),/no_verified/);
 assert.throws(()=>parseSource('sinya',html({...product,offers:{...product.offers,priceCurrency:'USD'}})),/no_verified/);
 assert.throws(()=>parseSource('sinya','RTX 5060 NT$9990'),/no_verified/);
});
