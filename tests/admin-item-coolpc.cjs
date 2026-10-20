const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(lookup){
 const dom=new JSDOM(read('admin.html'),{runScripts:'outside-only'}),w=dom.window;
 const modal=w.document.getElementById('itemEditorModal'),el=id=>modal.querySelector('#'+id);
 modal.hidden=false;el('itemCategory').innerHTML='<option value="處理器">處理器</option><option value="顯示卡">顯示卡</option>';
 el('itemName').value='AMD R5 7500F';el('itemPriceList').value='5000';
 const calls=[];w.DK={lookupCoolpcPrices:async args=>{calls.push(args);return lookup(args);}};
 w.eval(read('admin-item-coolpc.js'));
 return {dom,w,modal,el,calls,close:()=>dom.window.close()};
}
const result={ok:true,sourceUrl:'https://www.coolpc.com.tw/test',checkedAt:'2026-10-20T05:30:00Z',candidates:[{title:'R5 7500F 正常單品',price:4350,eligible:true},{title:'搭機價',price:3999,eligible:false,reason:'須搭配主機板'}]};
test('lookup uses modal category/spec and applies eligible price only after explicit click',async()=>{
 const s=setup(()=>result);s.el('itemCoolpcLookupBtn').click();await flush();assert.equal(s.calls[0].query,'AMD R5 7500F');assert.equal(s.calls[0].category,'處理器');
 assert.equal(s.el('itemPriceList').value,'5000');assert.equal(s.el('itemCoolpcLookupResults').hidden,false);
 const buttons=s.el('itemCoolpcLookupResults').querySelectorAll('button');assert.equal(buttons[1].disabled,true);buttons[1].click();assert.equal(s.el('itemPriceList').value,'5000');
 buttons[0].click();assert.equal(s.el('itemPriceList').value,'4350');assert.match(s.el('itemCoolpcLookupMsg').textContent,/按「儲存」/);assert.equal(s.calls.length,1);s.close();
});
test('missing name or category does not call the lookup service',async()=>{
 const s=setup(()=>result);s.el('itemName').value='';s.el('itemCoolpcLookupBtn').click();await flush();assert.equal(s.calls.length,0);s.el('itemName').value='CPU';s.el('itemCategory').value='';s.el('itemCoolpcLookupBtn').click();await flush();assert.equal(s.calls.length,0);assert.match(s.el('itemCoolpcLookupMsg').textContent,/品類/);s.close();
});
test('late response is ignored after category or product changes',async()=>{
 let resolve;const s=setup(()=>new Promise(r=>{resolve=r;}));s.el('itemCoolpcLookupBtn').click();s.el('itemName').value='RTX 5070';s.el('itemName').dispatchEvent(new s.w.Event('input'));resolve(result);await flush();assert.equal(s.el('itemCoolpcLookupResults').hidden,true);assert.equal(s.el('itemPriceList').value,'5000');assert.equal(s.el('itemCoolpcLookupBtn').disabled,false);s.close();
});
test('closing and reopening editor invalidates old responses even for the same product',async()=>{
 let resolve;const s=setup(()=>new Promise(r=>{resolve=r;}));s.el('itemCoolpcLookupBtn').click();s.modal.hidden=true;await flush();s.modal.hidden=false;await flush();resolve(result);await flush();assert.equal(s.el('itemCoolpcLookupResults').hidden,true);assert.equal(s.el('itemPriceList').value,'5000');s.close();
});
test('changing category discards candidate buttons from the previous query',async()=>{
 const s=setup(()=>result);s.el('itemCoolpcLookupBtn').click();await flush();s.el('itemCategory').value='顯示卡';s.el('itemCategory').dispatchEvent(new s.w.Event('change'));assert.equal(s.el('itemCoolpcLookupResults').children.length,0);assert.equal(s.el('itemPriceList').value,'5000');s.close();
});
test('network or permission failure keeps existing price and permits retry',async()=>{
 for(const lookup of [()=>{throw Error('offline');},()=>({ok:false,error:'只有管理員可以查詢原價屋行情'})]){
  const s=setup(lookup);s.el('itemCoolpcLookupBtn').click();await flush();assert.equal(s.el('itemPriceList').value,'5000');assert.equal(s.el('itemCoolpcLookupBtn').disabled,false);assert.equal(s.el('itemCoolpcLookupResults').hidden,true);assert.ok(s.el('itemCoolpcLookupMsg').textContent.length);s.close();
 }
});
test('candidate text and source URL cannot inject markup; invalid prices cannot apply',async()=>{
 const s=setup(()=>({ok:true,sourceUrl:'javascript:alert(1)',candidates:[{title:'<img src=x onerror=alert(1)>',price:0,eligible:true},{title:'Negative',price:-1,eligible:true},{title:'Invalid',price:'NaN',eligible:true}]}));s.el('itemCoolpcLookupBtn').click();await flush();const results=s.el('itemCoolpcLookupResults');assert.equal(results.querySelector('img'),null);assert.equal(results.querySelector('a'),null);assert.ok([...results.querySelectorAll('button')].every(b=>b.disabled));s.close();
});
