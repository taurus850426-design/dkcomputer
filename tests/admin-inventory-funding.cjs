const {test}=require('node:test');
const assert=require('node:assert/strict');
const {describe,populate}=require('../admin-inventory-funding.js');
const response=(owner='hala',boss=0,hala=2)=>({ok:true,data:{owner,boss_qty:boss,hala_qty:hala}});
const cell=id=>({dataset:{fundingItem:id},isConnected:true,textContent:'讀取中…',hidden:false,title:''});
test('funding labels reflect actual ownership and do not invent missing funding',()=>{
 assert.equal(describe(response()).label,'HALA');assert.equal(describe(response('boss',3,0)).label,'BOSS');
 assert.equal(describe(response('mixed',1,2)).label,'HALA／BOSS');assert.equal(describe(response('hala',0,0)).label,'—');
 assert.equal(describe({ok:false}).label,'讀取失敗');assert.equal(describe({ok:true,data:{owner:'hala'}}).label,'讀取失敗');
});
test('staff never request funding details',async()=>{
 const c=cell('a');let calls=0;await populate({querySelectorAll:()=>[c]},{stage7InventoryItemFunding:()=>calls++},()=>false);
 assert.equal(calls,0);assert.equal(c.hidden,true);assert.equal(c.textContent,'');
});
test('list reads always pass null owner and limit concurrent requests to four',async()=>{
 const cells=Array.from({length:9},(_,i)=>cell(String(i)));let active=0,max=0,calls=0;
 const dk={stage7InventoryItemFunding:async(id,owner)=>{assert.equal(owner,null);calls++;active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;return response();}};
 await populate({querySelectorAll:()=>cells},dk,()=>true);assert.equal(calls,9);assert.equal(max,4);assert.ok(cells.every(c=>c.textContent==='HALA'));
});
test('an older refresh cannot overwrite the new funding result',async()=>{
 const c=cell('a'),tbody={querySelectorAll:()=>[c]};let finish;
 const first=populate(tbody,{stage7InventoryItemFunding:()=>new Promise(r=>finish=r)},()=>true);
 await populate(tbody,{stage7InventoryItemFunding:async()=>response('boss',2,0)},()=>true);
 finish(response());await first;assert.equal(c.textContent,'BOSS');
});
test('permission loss while a request is pending hides the result',async()=>{
 const c=cell('a');let allowed=true,finish;
 const p=populate({querySelectorAll:()=>[c]},{stage7InventoryItemFunding:()=>new Promise(r=>finish=r)},()=>allowed);
 allowed=false;finish(response());await p;assert.equal(c.hidden,true);assert.equal(c.textContent,'');
});
test('network failure displays unavailable instead of a funding owner',async()=>{
 const c=cell('a');await populate({querySelectorAll:()=>[c]},{stage7InventoryItemFunding:async()=>{throw Error('offline')}},()=>true);assert.equal(c.textContent,'讀取失敗');
});
