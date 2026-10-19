(function(){
 'use strict';
 const section=document.getElementById('webShopOrders');if(!section)return;
 const message=document.getElementById('webShopMessage'),list=document.getElementById('webShopList');let busy=false,rows=[];
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>'NT$ '+Number(n).toLocaleString('zh-TW');
 const statuses={awaiting_confirmation:'待確認供貨',awaiting_payment:'待付款',payment_pending:'付款核對中',payment_review:'付款結果須人工核對',paid:'已付款',test_paid:'測試付款完成',fulfilled:'已出貨',cancelled:'已取消'};
 async function api(action,data={}){
  const auth=await window.DK.getSupabaseRestAuthHeaders({requireUser:true});if(!auth.ok)throw Error('請先登入管理員');
  const response=await fetch(window.DK.getSupabaseProjectUrl()+'/functions/v1/shop-checkout',{method:'POST',headers:{...auth.headers,'Content-Type':'application/json'},body:JSON.stringify({action,...data}),signal:AbortSignal.timeout(20000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'網站訂購服務尚未設定');return result;
 }
 function render(){
  list.innerHTML=rows.length?rows.map(row=>{const c=row.customer||{},buttons=[];
   if(row.status==='awaiting_confirmation')buttons.push('<label>運費 <input aria-label="運費" type="number" min="0" max="10000" step="1" value="0" data-fee="'+escape(row.id)+'" style="width:110px"></label><button class="btn btn-primary" data-action="approve">確認供貨並開放付款</button>');
   if(['awaiting_confirmation','awaiting_payment'].includes(row.status))buttons.push('<button class="btn btn-ghost" data-action="cancel">取消訂購</button>');
   if(row.status==='awaiting_payment'&&row.payment!=='credit')buttons.push('<button class="btn btn-ghost" data-action="manual_payment">登記已核實收款</button>');
   if(row.status==='paid'&&row.environment==='live')buttons.push('<button class="btn btn-primary" data-action="fulfill">確認出貨並扣官網數量</button>');
   const payment={credit:'信用卡',transfer:'轉帳',store:'到店付款'}[row.payment]||row.payment;
   return '<article data-shop-order="'+escape(row.id)+'" class="section-card-soft admin-stack-gap" style="padding:16px;overflow-wrap:anywhere"><h4>'+escape(row.order_no)+' '+(row.environment==='test'?'【測試】':'')+'</h4><p>'+escape(statuses[row.status]||row.status)+'｜'+escape(payment)+'｜'+money(row.subtotal)+(row.shipping_fee!=null?'＋運費 '+money(row.shipping_fee):'（運費待確認）')+'</p><p>'+escape(c.name)+'｜'+escape(c.phone)+'｜'+escape(c.email)+'</p><p>'+escape(c.fulfillment==='pickup'?'到店自取':c.address)+'</p><ul>'+row.items.map(x=>'<li>'+escape(x.name)+' × '+escape(x.qty)+'｜'+money(x.unit_price)+'</li>').join('')+'</ul><p>'+escape(c.note||'')+'</p><div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">'+buttons.join('')+'</div>'+(['payment_pending','payment_review'].includes(row.status)?'<p class="muted">付款已開始：請至金流後台核對，勿重複收款或任意釋放保留數量。</p>':'')+'</article>';
  }).join(''):'<p class="muted">尚無網站訂購需求。</p>';
 }
 async function refresh(){
  if(busy)return;busy=true;message.textContent='讀取網站訂購中…';
  try{rows=(await api('list')).rows||[];render();message.textContent='顯示最近50筆。此區不會自動新增或改動原有訂單、叫貨單及財務紀錄。';}catch(_){message.textContent='網站訂購服務尚未設定或目前無法連線；原有訂單可正常操作。';}finally{busy=false;}
 }
 document.getElementById('webShopRefresh').onclick=refresh;
 section.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button||busy)return;
  const row=rows.find(x=>x.id===button.closest('[data-shop-order]').dataset.shopOrder);if(!row)return;
  const action=button.dataset.action,data={id:row.id,version:row.updated_at};let text='';
  if(action==='approve'){data.shipping_fee=Number(section.querySelector('[data-fee="'+row.id+'"]').value);if(!Number.isInteger(data.shipping_fee)||data.shipping_fee<0||data.shipping_fee>10000){message.textContent='運費請輸入0至10000的整數';return;}text='確認供貨並保留官網商品數量？客人將可付款，總額為'+money(row.subtotal+data.shipping_fee)+'。原後台庫存及訂單不會自動建立或更動。';}
  if(action==='cancel')text='確認取消這筆網站訂購並解除官網保留數量？';
  if(action==='manual_payment'){const reference=prompt('請先核實銀行或現金收款，再填收款憑據／核對紀錄');if(!reference?.trim())return;data.reference=reference.trim();text='已核實收到款項，確認登記？此動作不會自動記入原後台財務。';}
  if(action==='fulfill')text='確認已安排出貨？此動作會扣除官網商品上架數量一次。原後台庫存與財務請依現行流程另外登記，避免重複扣帳。';
  if(!text||!confirm(row.order_no+'\n'+text))return;
  busy=true;button.disabled=true;message.textContent='處理中，請勿重複操作…';
  try{await api(action,data);message.textContent='已完成，正在更新…';}catch(e){message.textContent=e.message;busy=false;button.disabled=false;return;}busy=false;await refresh();
 });
})();
