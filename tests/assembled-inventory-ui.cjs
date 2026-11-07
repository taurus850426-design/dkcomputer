const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');const wait=()=>new Promise(r=>setTimeout(r,20));
function setup({fail=false,delay=false}={}){
 const dom=new JSDOM(fs.readFileSync('admin.html','utf8'),{url:'https://example.com/admin.html',runScripts:'outside-only'}),w=dom.window,calls=[];let finish,admin=true;
 for(const id of ['panel','tab-inv','v2-items'])w.document.getElementById(id).hidden=false;
 const item={id:'part1',name:'<script>not markup</script> CPU',category:'處理器',status:'READY',qty_on_hand:2};w.DK={getItems:()=>[item],findItemById:()=>item};w.stage7IsAdminRole=()=>admin;w.confirm=()=>true;
 w.dkAssemblyOperation=async(action,key,payload)=>{calls.push({action,key,payload:JSON.parse(JSON.stringify(payload))});if(action==='preview')return {ok:true,data:{material_cost:1000,funding:{boss:600,hala:400},condition:'NEW',signature:'sig1'}};if(action==='create'){if(delay)await new Promise(r=>finish=r);if(fail){fail=false;return {ok:false,error:'response not confirmed'};}return {ok:true,data:{id:'built',item_id:'pc',serial_no:'DK-PC1',idempotent:true}};}return {ok:true,data:[]};};
 w.eval(fs.readFileSync('admin-unsaved.js','utf8'));w.eval(fs.readFileSync('admin-assembly.js','utf8'));
 const el=id=>w.document.getElementById(id);el('btnAssembly').click();
 const fill=()=>{el('assemblyName').value='Test PC';el('assemblyName').dispatchEvent(new w.Event('input',{bubbles:true}));el('assemblySerial').value='DK-PC1';el('assemblyItem').value='part1';el('assemblySerials').value='SERIAL-1';el('assemblyAdd').click();};
 const preview=async()=>{el('assemblyPreview').click();await wait();};
 const confirm=()=>{el('assemblyReviewed').checked=true;el('assemblyReviewed').dispatchEvent(new w.Event('change'));el('assemblyCreate').click();};
 return {dom,w,el,calls,fill,preview,confirm,resolve:()=>finish(),staff:()=>{admin=false;w.DKAssembly.resetIfUnauthorized();}};
}
test('opening and previewing assembly do not write; unsafe names stay text and changed contents invalidate confirmation',async()=>{
 const s=setup();try{assert.equal(s.calls.length,0);s.fill();assert.equal(s.calls.length,0);assert.equal(s.el('assemblyParts').querySelector('script'),null);await s.preview();assert.deepEqual(s.calls.map(x=>x.action),['preview']);assert.equal(s.el('assemblyCreate').disabled,true);assert.match(s.el('assemblyPlan').textContent,/BOSS NT\$ 600/);s.el('assemblyName').value='Changed PC';s.el('assemblyName').dispatchEvent(new s.w.Event('input'));assert.equal(s.el('assemblyReviewed').checked,false);assert.equal(s.el('assemblyCreate').disabled,true);}finally{s.dom.window.close();}
});
test('ambiguous create retries the identical request key and payload, then uses existing result without a second stock write',async()=>{
 const s=setup({fail:true});try{s.fill();await s.preview();s.confirm();await wait();assert.match(s.el('assemblyMessage').textContent,/response not confirmed/);s.confirm();await wait();const writes=s.calls.filter(c=>c.action==='create');assert.equal(writes.length,2);assert.equal(writes[0].key,writes[1].key);assert.deepEqual(writes[0].payload,writes[1].payload);assert.match(s.el('assemblyMessage').textContent,/未重複扣庫存/);}finally{s.dom.window.close();}
});
test('double-click sends once and pending save locks edits; successful acknowledgement clears draft',async()=>{
 const s=setup({delay:true});try{s.fill();await s.preview();s.confirm();s.el('assemblyCreate').click();assert.equal(s.calls.filter(c=>c.action==='create').length,1);assert.equal(s.el('assemblyName').disabled,true);s.resolve();await wait();assert.equal(s.el('assemblyName').disabled,false);assert.equal(s.el('assemblyName').value,'');assert.equal(s.el('assemblyCreate').disabled,true);}finally{s.dom.window.close();}
});
test('dirty assembly blocks leaving; a role change clears private preview and history, and makes no further requests',async()=>{
 const s=setup();try{s.fill();await s.preview();s.el('assemblyClose').click();assert.ok(s.w.document.querySelector('[data-choice="stay"]'));s.w.document.querySelector('[data-choice="stay"]').click();assert.equal(s.el('assemblyPanel').hidden,false);const n=s.calls.length;s.staff();assert.equal(s.el('assemblyPanel').hidden,true);assert.equal(s.el('assemblyPlan').textContent,'');s.el('btnAssembly').click();s.el('assemblyReload').click();await wait();assert.equal(s.calls.length,n);}finally{s.dom.window.close();}
});
