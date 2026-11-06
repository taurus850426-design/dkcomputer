import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseSinyaProducts,collectSinya,COMPONENT_CATEGORIES} from '../scripts/sinya-source.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/sinya-products.json',import.meta.url)));
test('real Sinya fixture separates displayed single-item price from assembly, bundle and conditional offers',()=>{
 const result=parseSinyaProducts(fixture,5,'VGA 顯示卡','2026-11-06T16:35:00Z');
 assert.equal(result.length,1);assert.equal(result[0].sourceProductId,'226887');assert.equal(result[0].price,16888);
 assert.equal(result[0].url,'https://www.sinya.com.tw/prod/226887');
});
test('hidden prices, campaigns, unavailable stock, inconsistent price fields and wrong categories are rejected',()=>{
 const normal=fixture.find(x=>x.prod_id==='226887');
 for(const change of [{price:5060},{current_price:1},{special_price:100},{display_price_status:0},{stocks:0},{max_amount:0},{price_comment:'限組裝'},{activity_start_date:'2026-11-01'}])assert.equal(parseSinyaProducts([{...normal,...change}],5,'VGA').length,0);
 assert.throws(()=>parseSinyaProducts([normal],1,'CPU'),/category_mismatch/);
 assert.throws(()=>parseSinyaProducts({message:'busy'},5,'VGA'),/invalid_product_response/);
 assert.equal(parseSinyaProducts([normal],5,'限組裝').length,0);
});
test('all component categories are fetched before a feed is returned; one failing group aborts the snapshot',async()=>{
 const normal=fixture.find(x=>x.prod_id==='226887'),calls=[];
 const mock=fail=>async(url,opts)=>{
  calls.push(String(url));const isGroup=String(url).includes('show_option');
  const category=isGroup?new URLSearchParams(opts.body).get('id'):new URL(url).searchParams.get('sub_slave_id');
  if(fail&&category==='3'&&!isGroup)return {ok:false,status:503};
  const value=isGroup?{showOption:[{group_id:category,prod_sub_slave_id:category,title:'一般商品',link:''}]}:Array.from({length:10},(_,i)=>({...normal,prod_id:String(Number(category)*100+i),sub_slave_id:Number(category)}));
  return {ok:true,text:async()=>JSON.stringify(value)};
 };
 const result=await collectSinya({fetchImpl:mock(false),pause:async()=>{}});
 assert.equal(result.coverage.length,COMPONENT_CATEGORIES.length);assert.equal(result.products.length,110);assert.equal(calls.length,22);
 await assert.rejects(collectSinya({fetchImpl:mock(true),pause:async()=>{}}),/sinya_HTTP_503/);
});
