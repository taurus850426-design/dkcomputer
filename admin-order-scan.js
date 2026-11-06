(function(root){
 'use strict';
 const el=id=>document.getElementById(id), esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let orderId='',state=null,busy=false,generation=0;
 const message=t=>{if(el('orderScanMessage'))el('orderScanMessage').textContent=t;};
 function render(){
  const select=el('orderScanLine'),list=el('orderScanSerials');if(!select||!list)return;
  const selected=select.value;
  select.innerHTML='<option value="">請選擇要裝的零件</option>'+(state?.lines||[]).filter(l=>l.fulfillment_type!=='service').map(l=>'<option value="'+esc(l.line_key)+'">'+esc(l.name)+' × '+esc(l.qty)+(l.item_id?'':'（尚未到貨）')+'</option>').join('');
  if(Array.from(select.options).some(x=>x.value===selected))select.value=selected;
  list.innerHTML=(state?.serials||[]).map(s=>'<li>'+esc(s.serial_no)+'｜'+esc((state.lines||[]).find(l=>l.line_key===s.line_key)?.name||'原品項已異動')+'｜'+(s.checked?'已掃描核對':'待組裝掃描')+(s.status==='sold'?'／已交付':'')+'</li>').join('')||'<li>尚無序號。先到貨登記；舊庫存可核對型號後補登。</li>';
  if(el('orderScanTestState'))el('orderScanTestState').textContent=state?.scan_test_current?'已確認測試合格':'尚未確認測試／零件有異動';
  document.querySelectorAll('[data-order-scan-action]').forEach(b=>b.disabled=busy||!state||state.status!=='confirmed'||state.delivery_status==='delivered');
 }
 async function request(action,code='',line=''){
  const id=orderId,gen=generation;if(!id)return message('請先儲存訂單，再開啟掃碼核對。');
  if(busy)return;
  if(action!=='inspect'){const reason=root.DKOrderScanCanWrite?.(state?.updated_at);if(reason)return message(reason);}
  const previousVersion=state?.updated_at;busy=true;render();message('正在核對雲端紀錄…');
  try{
   if(typeof root.DKOrderScanRpc!=='function')throw new Error('掃碼功能尚未載入，請重新整理');
   const r=await root.DKOrderScanRpc({p_order_id:id,p_action:action,p_code:code,p_line_key:line,p_expected_updated_at:state?.updated_at??null});
   if(gen!==generation)return;
   if(!r?.ok||!r.data?.ok)throw new Error(r?.error||'核對失敗，請重新載入');
   state=r.data;message(action==='inspect'?'已載入雲端序號；掃描只輸入，按確認才儲存。':action==='test'?'已記錄人工確認測試合格。':action==='ship'?'已確認交付，序號已標記售出；沒有再次扣庫存。':'序號核對已儲存。');
   if(action!=='inspect'){
    // Refresh the existing editor's optimistic version without replacing unsaved form values.
    root.dispatchEvent(new CustomEvent('dk:order-scan-saved',{detail:{id,previous_version:previousVersion,updated_at:state.updated_at,delivery_status:state.delivery_status}}));
    if(el('orderScanCode'))el('orderScanCode').value='';
   }
  }catch(e){if(gen===generation)message(e.message||String(e));}
  finally{if(gen===generation){busy=false;render();}}
 }
 function load(order){generation++;orderId=String(order?.id||'');state=null;busy=false;render();if(el('orderScanCode'))el('orderScanCode').value='';if(el('orderScanShipmentCode'))el('orderScanShipmentCode').value='';message(orderId?'請點「載入／重新核對」取得最新序號。':'請先儲存訂單，再使用掃碼核對。');}
 function bind(){
  document.addEventListener('keydown',e=>{if(['orderScanCode','orderScanShipmentCode'].includes(e.target.id)&&e.key==='Enter'){e.preventDefault();e.stopPropagation();message('已讀入條碼，請核對後按確認。');}},true);
  document.addEventListener('click',e=>{
   const b=e.target.closest('[data-order-scan-action]');if(!b||busy)return;
   const action=b.dataset.orderScanAction;
   const code=(el(action==='ship'?'orderScanShipmentCode':'orderScanCode')?.value||'').trim(),line=el('orderScanLine')?.value||'';
   if(['bind','register','unbind'].includes(action)&&(!code||!line))return message('請先選零件並掃描序號。');
   if(action==='ship'&&!code)return message('請掃描本張訂單編號。');
   if(action==='register'&&!root.confirm('請人工核對實物型號與所選訂單零件相同。\n補登此 S/N 或已貼上的 DK 編號？此步驟不會增加庫存數量。'))return;
   if(action==='test'&&!root.confirm('請確認已實際完成出貨前測試，結果合格。\n系統只記錄你的確認，不會代替實際測試。'))return;
   if(action==='ship'&&!root.confirm('確認實際交付這張訂單？系統會核對款項、零件及測試確認，不會再次扣庫存。'))return;
   request(action,code,line);
  });
 }
 root.DKOrderScan={load,request};bind();
})(window);
