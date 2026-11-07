/* Explicit inventory transformation. Preview and opening never write business rows. */
(function(){
 'use strict';
 const el=id=>document.getElementById(id),panel=el('assemblyPanel');if(!panel)return;
 const msg=text=>{el('assemblyMessage').textContent=text;},money=n=>'NT$ '+Number(n).toLocaleString('zh-TW');
 let parts=[],plan=null,key=null,busy=false,history=[],generation=0;
 const admin=()=>window.stage7IsAdminRole?.()===true;
 const payload=()=>({name:el('assemblyName').value.trim(),serial_no:el('assemblySerial').value.trim(),parts});
 const invalidate=()=>{plan=null;el('assemblyPlan').replaceChildren();el('assemblyReviewed').checked=false;el('assemblyCreate').disabled=true;};
 const guard=window.DKUnsaved?.register('assembly',{label:'整機轉換',root:panel,read:()=>({payload:payload(),pending:(el('assemblyItem').value||el('assemblySerials').value.trim()||el('assemblySerialNote').value.trim())?[el('assemblyItem').value,el('assemblyQty').value,el('assemblySerials').value,el('assemblySerialNote').value]:null}),busy:()=>busy,save:()=>{msg('請先預覽、核對並確認轉換，再離開。');return false;},discard:()=>{window.DKCameraScan?.close();panel.hidden=true;generation++;}});
 function lock(value){busy=value;for(const input of panel.querySelectorAll('button,input,select,textarea'))input.disabled=value;el('assemblyCreate').disabled=value||!plan||!el('assemblyReviewed').checked;}
 function options(){
  const chosen=el('assemblyItem').value,q=el('assemblySearch').value.trim().toLowerCase(),select=el('assemblyItem');select.replaceChildren(new Option('選擇零件',''));
  for(const item of window.DK?.getItems?.()||[])if(Number(item.qty_on_hand)>0&&!item.exclude_from_inventory_value&&!item.assembly_id&&item.category!=='整機'&&item.status==='READY'&&[item.name,item.category,item.sku].join(' ').toLowerCase().includes(q))select.add(new Option([item.category,item.name,'可用 '+item.qty_on_hand].join('｜'),item.id));
  if([...select.options].some(x=>x.value===chosen))select.value=chosen;
 }
 function renderParts(){
  el('assemblyParts').replaceChildren();parts.forEach((part,index)=>{const row=document.createElement('li'),button=document.createElement('button');row.textContent=part.name+' × '+part.qty+'｜'+(part.serials.length?part.serials.join('、'):'無序號：'+part.serial_note)+' ';button.type='button';button.textContent='移除';button.dataset.removeAssemblyPart=String(index);row.append(button);el('assemblyParts').append(row);});
 }
 async function rpc(action,id,data){const r=await window.dkAssemblyOperation(action,id,data);if(!r?.ok)throw Error(r?.error||'連線結果未確認，請先載入轉換紀錄核對；不要另外建立同一台整機。');return r.data;}
 async function refreshCore(){if(typeof window.fetchV2DataFromSupabase==='function')await window.fetchV2DataFromSupabase();window.__adminV2Refresh?.();}
 async function loadHistory(){
  if(busy||!admin())return;const token=generation;lock(true);
  try{const data=await rpc('list',null,{});if(token!==generation||!admin())return;history=Array.isArray(data)?data:[];const host=el('assemblyHistoryList');host.replaceChildren();
   for(const row of history){const box=document.createElement('details'),title=document.createElement('summary'),p=document.createElement('p'),list=document.createElement('ul');title.textContent=row.serial_no+'｜'+row.name+'｜'+(row.state==='disassembled'?'已拆回':({sold:'已出售',reserved:'已預留',returned:'已退貨待驗收',in_stock:'在庫'}[row.serial_status]||'已轉整機'));p.textContent='移轉成本 '+money(row.material_cost)+'；原出資 BOSS '+money(row.funding.boss)+'、HALA '+money(row.funding.hala);
    for(const part of row.parts||[]){const li=document.createElement('li');li.textContent=part.category+'｜'+part.name+' × '+part.qty+'｜成本 '+money(part.unit_cost*part.qty)+'｜'+(part.serials.length?part.serials.join('、'):'無序號：'+part.serial_note);list.append(li);}
    const print=document.createElement('button');print.type='button';print.textContent='列印整機貼紙';print.dataset.assemblyPrint=row.id;
    box.append(title,p,list,print);
    if(row.state==='ready'&&Number(row.qty_on_hand)===1&&row.serial_status==='in_stock'){const undo=document.createElement('button');undo.type='button';undo.textContent='未售整機拆回零件';undo.dataset.assemblyUndo=row.id;box.append(undo);}host.append(box);
   }if(!history.length)host.textContent='尚無轉換紀錄。';
  }catch(e){msg(e.message);}finally{lock(false);}
 }
 el('btnAssembly')?.addEventListener('click',()=>{
  if(!admin()||busy||guard?.dirty())return;generation++;panel.hidden=false;parts=[];key=crypto.randomUUID();el('assemblyForm').reset();invalidate();renderParts();options();msg('先選擇實際零件；預覽不會扣庫存或記帳。');guard?.clean();panel.scrollIntoView?.({behavior:'smooth',block:'start'});
 });
 el('assemblyClose').addEventListener('click',()=>{if(busy||guard?.dirty())return;window.DKCameraScan?.close();panel.hidden=true;generation++;guard?.reset();});
 el('assemblyForm').addEventListener('submit',e=>e.preventDefault());
 for(const id of ['assemblySerial','assemblySerials','assemblyTrace'])el(id).addEventListener('keydown',e=>{if(e.key==='Enter'&&id!=='assemblySerials'){e.preventDefault();e.stopPropagation();}});
 el('assemblySearch').addEventListener('input',options);
 el('assemblyItem').addEventListener('change',invalidate);
 el('assemblyGenerate').addEventListener('click',()=>{el('assemblySerial').value='DK-AS-'+crypto.randomUUID().replace(/-/g,'').slice(0,16).toUpperCase();invalidate();});
 for(const id of ['assemblyName','assemblySerial'])el(id).addEventListener('input',invalidate);
 el('assemblyAdd').addEventListener('click',()=>{
  if(busy)return;const item=window.DK?.findItemById?.(el('assemblyItem').value),qty=Number(el('assemblyQty').value),serials=el('assemblySerials').value.split(/[\r\n,，;；]+/).map(x=>x.trim()).filter(Boolean),note=el('assemblySerialNote').value.trim();
  if(!item||!Number.isInteger(qty)||qty<1||qty>999)return msg('請選擇零件與有效整數數量。');
  if(parts.some(x=>x.item_id===item.id))return msg('此零件已加入，請移除後調整數量，避免重複。');
  if(serials.length&&serials.length!==qty)return msg('序號數量須與裝入數量相同。');
  if(!serials.length&&note.length<5)return msg('沒有序號時，請填至少 5 個字的原因。');
  parts.push({item_id:item.id,name:item.name,qty,serials,serial_note:note});el('assemblyItem').value='';el('assemblyQty').value='1';el('assemblySerials').value='';el('assemblySerialNote').value='';invalidate();renderParts();msg('已加入待核對清單，尚未扣庫存。');
 });
 el('assemblyParts').addEventListener('click',e=>{const btn=e.target.closest('[data-remove-assembly-part]');if(!btn||busy)return;parts.splice(Number(btn.dataset.removeAssemblyPart),1);invalidate();renderParts();});
 el('assemblyPreview').addEventListener('click',async()=>{
  if(busy||!admin())return;if(el('assemblyItem').value||el('assemblySerials').value.trim()||el('assemblySerialNote').value.trim())return msg('選取的零件尚未加入清單，請先加入或清空選擇。');
  if(!payload().name||!payload().serial_no||!parts.length)return msg('請填整機名稱、編號並加入零件。');
  const token=generation;lock(true);invalidate();try{const result=await rpc('preview',null,payload());if(token!==generation||!admin())return;plan=result;const summary=document.createElement('p');summary.textContent='轉換後：1 台整機，'+(plan.condition==='NEW'?'全新零件':'含中古／非全新零件')+'；移轉成本 '+money(plan.material_cost)+'；原出資本金 BOSS '+money(plan.funding.boss)+'、HALA '+money(plan.funding.hala)+'。';el('assemblyPlan').append(summary);msg('預覽完成，尚未扣庫存。核對原零件與實際組裝後再確認。');}catch(e){invalidate();msg(e.message);}finally{lock(false);}
 });
 el('assemblyReviewed').addEventListener('change',()=>{el('assemblyCreate').disabled=busy||!plan||!el('assemblyReviewed').checked;});
 el('assemblyCreate').addEventListener('click',async()=>{
  if(busy||!admin()||!plan||!el('assemblyReviewed').checked)return;
  if(el('assemblyItem').value||el('assemblySerials').value.trim()||el('assemblySerialNote').value.trim())return msg('另有零件尚未加入清單，請先核對。');
  if(!confirm('確認已實際組裝這些零件，轉成一台整機？零件會移出可用庫存，成本與原出資帶入整機。'))return;
  const token=generation,body={...payload(),signature:plan.signature,reviewed:true};lock(true);
  try{const r=await rpc('create',key,body);if(token!==generation||!admin())return;guard?.clean();msg('已轉成整機：'+r.serial_no+(r.idempotent?'（沿用既有紀錄，未重複扣庫存）':'')+'。出售時只選這台整機。');parts=[];el('assemblyForm').reset();invalidate();renderParts();guard?.clean();key=crypto.randomUUID();try{await refreshCore();options();}catch(_){msg('轉換已完成，但庫存畫面更新失敗；請重新整理，勿重複轉換。');}}catch(e){msg(e.message);}finally{lock(false);}
 });
 el('assemblyReload').addEventListener('click',loadHistory);
 el('assemblyHistory').addEventListener('toggle',()=>{if(el('assemblyHistory').open)loadHistory();});
 el('assemblyHistoryList').addEventListener('click',async e=>{
  const btn=e.target.closest('[data-assembly-undo],[data-assembly-print]');if(!btn||busy||!admin())return;const row=history.find(x=>x.id===(btn.dataset.assemblyUndo||btn.dataset.assemblyPrint));if(!row)return;
  if(btn.dataset.assemblyPrint)return window.DKScanner?.printLabels([row.serial_no]);
  if(!confirm('確認 '+row.serial_no+' 尚未出售且已實際拆回清單內所有零件？原零件與出資會回復，整機編號保留作廢。'))return;
  lock(true);try{await rpc('disassemble',row.id,{reviewed:true});msg('整機已拆回零件；原序號與出資已恢復，整機紀錄保留。');await refreshCore();options();}catch(e){msg(e.message);}finally{lock(false);}await loadHistory();
 });
 el('assemblyTraceBtn').addEventListener('click',async()=>{if(busy||!admin())return;const token=generation;lock(true);try{const data=await rpc('trace',null,{serial:el('assemblyTrace').value.trim()});if(token!==generation||!admin())return;el('assemblyTraceResult').textContent=data.length?JSON.stringify(data,null,2):'查無組裝紀錄。';}catch(e){msg(e.message);}finally{lock(false);}});
 window.DKAssembly={resetIfUnauthorized(){if(admin())return;generation++;window.DKCameraScan?.close();panel.hidden=true;parts=[];history=[];key=null;invalidate();renderParts();el('assemblyHistoryList').replaceChildren();el('assemblyTraceResult').textContent='';el('assemblyForm').reset();msg('');guard?.reset();}};
})();
