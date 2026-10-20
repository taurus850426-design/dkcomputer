(function(){
 'use strict';
 const section=document.getElementById('webShopOrders');if(!section)return;
 const message=document.getElementById('webShopMessage'),list=document.getElementById('webShopList');let busy=false,rows=[],page=0,dirty=false;
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>'NT$ '+Number(n).toLocaleString('zh-TW');
 const statuses={awaiting_confirmation:'待確認供貨',awaiting_payment:'待付款',payment_review:'已回報轉帳，待核實',paid:'已核實收款',test_paid:'測試單',fulfilled:'已交付',cancelled:'已取消'};
 async function api(action,data={}){
  const auth=await window.DK.getSupabaseRestAuthHeaders({requireUser:true});if(!auth.ok)throw Error('請先登入管理員');
  const response=await fetch(window.DK.getSupabaseProjectUrl()+'/functions/v1/shop-checkout',{method:'POST',headers:{...auth.headers,'Content-Type':'application/json'},body:JSON.stringify({action,...data}),signal:AbortSignal.timeout(20000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'網站訂購暫時無法連線，請稍後更新');return result;
 }
 function render(){
  list.innerHTML=rows.length?rows.map(row=>{const c=row.customer||{},buttons=[];
   const instructions=row.payment==='transfer'?'請加入官方 LINE，提供本頁單號，確認收款帳號後再轉帳。':'請先與官方 LINE 確認自取地址及時間，到店付款。';
   if(row.status==='awaiting_confirmation')buttons.push('<label>運費 <input aria-label="運費" type="number" min="0" max="10000" step="1" value="0" data-fee="'+escape(row.id)+'" style="width:110px" '+(c.fulfillment==='pickup'?'readonly':'')+'></label><label style="flex:1 1 100%">付款／取貨說明（客人可見，可填銀行代碼、帳號及聯絡方式）<textarea rows="3" maxlength="2000" data-instructions="'+escape(row.id)+'" style="display:block;width:100%">'+escape(instructions)+'</textarea></label><button type="button" class="btn btn-primary" data-action="approve">確認供貨並提供付款資訊</button>');
   if(['awaiting_confirmation','awaiting_payment','payment_review'].includes(row.status))buttons.push('<button type="button" class="btn btn-ghost" data-action="cancel">取消訂購</button>');
   if(['awaiting_payment','payment_review'].includes(row.status))buttons.push('<button type="button" class="btn btn-ghost" data-action="manual_payment">登記已核實收款</button>');
   if(row.status==='paid'&&row.environment==='live')buttons.push('<button type="button" class="btn btn-primary" data-action="fulfill">確認交付並扣官網數量</button>');
   buttons.push('<button type="button" class="btn btn-ghost" data-action="copy">複製訂購資料</button>');
   return '<article data-shop-order="'+escape(row.id)+'" class="section-card-soft admin-stack-gap" style="padding:16px;overflow-wrap:anywhere"><h4>'+escape(row.order_no)+' '+(row.environment==='test'?'【測試】':'')+'</h4><p>'+escape(statuses[row.status]||row.status)+'｜'+escape(row.payment==='store'?'到店付款':'銀行轉帳')+'｜'+money(row.subtotal)+(row.shipping_fee!=null?'＋運費 '+money(row.shipping_fee)+'＝'+money(row.subtotal+row.shipping_fee):'（運費待確認）')+'</p><p>'+escape(c.name)+'｜'+escape(c.phone)+'｜'+escape(c.email)+'</p><p>'+escape(c.fulfillment==='pickup'?'到店自取':c.address)+'</p><ul>'+row.items.map(x=>'<li>'+escape(x.name)+' × '+escape(x.qty)+'｜單價 '+money(x.unit_price)+'</li>').join('')+'</ul><p>客人備註：'+escape(c.note||'無')+'</p>'+(row.transfer_last5?'<p><strong>客人回報轉出帳號末五碼：'+escape(row.transfer_last5)+'（請核對實際銀行入帳）</strong></p>':'')+(row.customer_message?'<p style="white-space:pre-wrap">客人可見說明：'+escape(row.customer_message)+'</p>':'')+(row.hold_until&&row.status==='awaiting_payment'?'<p>保留期限：'+escape(new Date(row.hold_until).toLocaleString('zh-TW'))+'</p>':'')+'<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">'+buttons.join('')+'</div></article>';
  }).join(''):'<p class="muted">此頁尚無網站訂購需求。</p>';
 }
 async function refresh(){
  if(busy)return;busy=true;message.textContent='讀取網站訂購中…';
  try{const result=await api('list',{page});rows=result.rows||[];render();dirty=false;message.textContent='第'+(page+1)+'頁，每頁最多25筆。網站單獨立管理；原後台庫存與財務請另依現行流程登記。';document.getElementById('webShopPrev').disabled=page===0;document.getElementById('webShopNext').disabled=!result.hasMore;}catch(e){message.textContent=e.message||'網站訂購暫時無法連線，請稍後更新。';}finally{busy=false;}
 }
 const canReload=()=>!dirty||confirm('尚有未送出的運費／付款說明，確定放棄並重新載入？');
 section.addEventListener('input',()=>{dirty=true;});
 document.getElementById('webShopRefresh').onclick=()=>{if(!busy&&canReload()){page=0;refresh();}};
 document.getElementById('webShopPrev').onclick=()=>{if(!busy&&page>0&&canReload()){page--;refresh();}};
 document.getElementById('webShopNext').onclick=()=>{if(!busy&&canReload()){page++;refresh();}};
 section.addEventListener('toggle',()=>{if(section.open&&!dirty)refresh();});
 setInterval(()=>{if(section.open&&!document.hidden&&!dirty)refresh();},60000);
 section.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button||busy)return;
  const row=rows.find(x=>x.id===button.closest('[data-shop-order]').dataset.shopOrder);if(!row)return;
  const action=button.dataset.action,data={id:row.id,version:row.updated_at};let text='';
  if(action==='copy'){
   const c=row.customer||{},lines=[row.order_no,statuses[row.status],c.name,c.phone,c.email,c.fulfillment==='pickup'?'到店自取':c.address,...row.items.map(x=>x.name+' × '+x.qty+'｜單價 '+money(x.unit_price)),'商品小計 '+money(row.subtotal),'運費 '+(row.shipping_fee==null?'待確認':money(row.shipping_fee)),'客人備註：'+(c.note||'無')];
   try{await navigator.clipboard.writeText(lines.join('\n'));message.textContent='訂購資料已複製，建立原後台訂單時請記錄WEB單號，避免重複入帳。';}catch(_){message.textContent='無法存取剪貼簿，請直接選取上方訂購資料複製。';}return;
  }
  if(action==='approve'){data.shipping_fee=Number(section.querySelector('[data-fee="'+row.id+'"]').value);data.message=section.querySelector('[data-instructions="'+row.id+'"]').value.trim();if(!Number.isInteger(data.shipping_fee)||data.shipping_fee<0||data.shipping_fee>10000||data.message.length<5){message.textContent='請填有效運費及客人可見的付款／取貨說明';return;}text='已核對供貨，確認保留官網數量並提供付款資訊？總額'+money(row.subtotal+data.shipping_fee)+'。轉帳單保留48小時；本次不會新增原後台訂單或入帳。';}
  if(action==='cancel')text=(row.status==='payment_review'?'客人已回報轉帳，請先核對銀行入帳及退款安排。':'請先確認客人是否已匯款。')+'確定取消此筆網站訂購並解除保留？';
  if(action==='manual_payment'){const reference=prompt('請先核實已收到 '+money(row.subtotal+row.shipping_fee)+'，填入收款憑據／核對紀錄（最多200字）');if(!reference?.trim())return;data.reference=reference.trim();if(data.reference.length>200){message.textContent='核對紀錄請勿超過200字';return;}text='確認已核實收到全額款項？客人的查單頁會顯示已收款。原後台財務仍需另行登記。';}
  if(action==='fulfill')text='確認已交付商品？本次扣除官網上架數量一次。後台零件庫存與財務請依現行流程另外登記，避免重複扣帳。';
  if(!text||!confirm(row.order_no+'\n'+text))return;
  busy=true;button.disabled=true;message.textContent='處理中，請勿重複操作…';
  try{await api(action,data);}catch(e){message.textContent=e.message;busy=false;button.disabled=false;return;}busy=false;await refresh();
 });
})();
