const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');const {JSDOM}=require('jsdom');
const html=fs.readFileSync('admin.html','utf8'),script=fs.readFileSync('admin-order-scan.js','utf8');
const state=(id='o1')=>({ok:true,id,order_no:'DK-1',status:'confirmed',updated_at:'v1',delivery_status:'pending',lines:[{line_key:'cpu',item_id:'i1',name:'CPU <script>',qty:1,fulfillment_type:'inventory'}],serials:[]});
test('scanner Enter never submits the order or writes; confirmation binds explicit line and version',async()=>{
 const dom=new JSDOM(html,{runScripts:'outside-only'}),w=dom.window;try{
 let calls=[],submitted=0;w.DKOrderScanRpc=async p=>{calls.push(p);return {ok:true,data:state()}};w.confirm=()=>true;w.eval(script);w.document.querySelector('#orderForm').addEventListener('submit',()=>submitted++);w.DKOrderScan.load({id:'o1'});await w.DKOrderScan.request('inspect');
 const select=w.document.querySelector('#orderScanLine');assert.equal(select.options[1].textContent,'CPU <script> × 1');assert.equal(select.querySelector('script'),null);select.value='cpu';
 const input=w.document.querySelector('#orderScanCode');input.value='SN1';const enter=new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});input.dispatchEvent(enter);assert.equal(enter.defaultPrevented,true);assert.equal(calls.length,1);assert.equal(submitted,0);
 w.document.querySelector('[data-order-scan-action="bind"]').click();await new Promise(r=>setImmediate(r));assert.equal(calls.length,2);assert.equal(calls[1].p_action,'bind');assert.equal(calls[1].p_code,'SN1');assert.equal(calls[1].p_line_key,'cpu');assert.equal(calls[1].p_expected_updated_at,'v1');
 }finally{w.close();}
});
test('stale responses cannot enter another order; unsaved drafts prevent scan writes',async()=>{
 const dom=new JSDOM(html,{runScripts:'outside-only'}),w=dom.window;try{
 let finish,calls=0;w.eval(script);w.DKOrderScanRpc=()=>{calls++;return new Promise(r=>finish=r)};w.DKOrderScan.load({id:'o1'});const pending=w.DKOrderScan.request('inspect');w.DKOrderScan.load({id:'o2'});finish({ok:true,data:state('o1')});await pending;assert.equal(w.document.querySelector('#orderScanLine').options.length,1);
 w.DKOrderScanRpc=async()=>({ok:true,data:state('o2')});await w.DKOrderScan.request('inspect');w.DKOrderScanCanWrite=()=> '請先儲存';await w.DKOrderScan.request('bind','SN1','cpu');assert.match(w.document.querySelector('#orderScanMessage').textContent,/請先儲存/);assert.equal(calls,1);
 }finally{w.close();}
});
test('receipt scanner input splits real newline and preserves letters r/n in serials',()=>{
 const po=fs.readFileSync('purchase-orders.js','utf8'),match=po.match(/const serialNumbers = (.*);/);assert.ok(match);const parse=new Function('el','return '+match[1]);const serials=parse(()=>({value:'sn-one\r\nRNR-123\nthird'}));assert.deepEqual(serials,['sn-one','RNR-123','third']);
});
