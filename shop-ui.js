(function(){
 'use strict';
 const KEY='dk_shop_cart_v1',HISTORY='dk_shop_orders_v1',PENDING='dk_shop_pending_v1';
 const core=window.DKShopCore,config=window.DKShopConfig||{},el=id=>document.getElementById(id);
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>'NT$ '+Number(n).toLocaleString('zh-TW');
 const validRecord=x=>x&&/^[0-9a-f-]{36}$/i.test(x.id)&&/^[0-9a-f]{64}$/.test(x.token);
 let catalog=[],service=null,busy=false,tracking=null,records=[];
 const note=t=>{if(el('shopFormMsg'))el('shopFormMsg').textContent=t;};
 function read(){try{return core.normalizeCart(JSON.parse(localStorage.getItem(KEY)||'[]'));}catch(_){return [];}}
 function write(rows){localStorage.setItem(KEY,JSON.stringify(core.normalizeCart(rows)));render();}
 async function api(action,data={}){
  const response=await fetch(window.DK.getSupabaseProjectUrl()+'/functions/v1/shop-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...data}),signal:AbortSignal.timeout(20000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'服務暫時無法使用，請稍後再試');return result;
 }
 function add(id){
  const rows=read(),existing=rows.find(x=>x.id===id);
  if(existing){if(existing.qty>=99)throw Error('單一商品最多99件，請聯絡店家洽詢大量訂購');existing.qty++;}
  else{if(rows.length>=20)throw Error('一次最多選購20種商品');rows.push({id,qty:1});}
  const q=core.quote(rows,catalog);if(q.errors.length)throw Error(q.errors.join('；'));write(rows);
 }
 function render(){
  const rows=read(),q=core.quote(rows,catalog);if(el('shopCount'))el('shopCount').textContent=rows.reduce((n,x)=>n+x.qty,0);
  if(!el('shopCartItems'))return;
  el('shopCartItems').innerHTML=rows.length?rows.map(line=>{const item=catalog.find(p=>String(p.id)===line.id);return '<div class="shop-cart-line"><h3>'+esc(item?.name||'已下架商品')+'</h3><div class="shop-cart-controls"><label>數量 <input type="number" min="1" max="99" value="'+line.qty+'" data-shop-qty="'+esc(line.id)+'"></label><button type="button" class="shop-secondary" data-shop-remove="'+esc(line.id)+'">移除</button></div></div>';}).join(''):'<p class="shop-help">購物車還沒有商品。</p>';
  el('shopTotal').textContent=money(q.total);el('shopErrors').textContent=q.errors.join('；');el('shopSubmit').disabled=busy||!service?.enabled||!rows.length||!!q.errors.length;
 }
 async function reload(){
  el('shopProducts').textContent='正在載入商品…';
  try{
   const data=await api('catalog');if(!Array.isArray(data.items))throw Error();catalog=data.items;
   el('shopProducts').innerHTML=catalog.map(item=>{
    const valid=core.quote([{id:String(item.id),qty:1}],catalog).errors.length===0;let image='';
    try{const u=new URL(item.photos?.[0]||'');if(u.protocol==='https:')image='<img src="'+esc(u.href)+'" alt="" loading="lazy">';}catch(_){}
    return '<article class="shop-product">'+image+'<div class="shop-product-body"><h3><a href="./product.html?id='+encodeURIComponent(item.id)+'">'+esc(item.name)+'</a></h3><strong>'+esc(item.requires_quote?'型號與售價請先詢問':item.price>0?money(item.price):'價格待確認')+'</strong><p>'+esc(item.requires_quote?'多規格商品，請先與店家核對':item.qty==null?'數量待確認':'目前可供確認 '+item.qty+' 件')+'</p><button type="button" class="shop-primary" data-shop-add="'+esc(item.id)+'" '+(valid?'':'disabled')+'>'+(valid?'加入購物車':'請先聯絡確認')+'</button></div></article>';
   }).join('')||'<p>目前沒有上架商品，歡迎透過官方 LINE 詢問。</p>';
  }catch(_){catalog=[];el('shopProducts').textContent='目前無法取得最新商品，請稍後更新；購物車已保留。';}render();
 }
 function product(item){
  if(!config.enabled&&!config.preview)return;
  el('shopProductAdd')?.remove();const host=el('productPageLineBtn');if(!host)return;
  const wrap=document.createElement('div');wrap.id='shopProductAdd';wrap.style.cssText='display:flex;gap:10px;flex-wrap:wrap;margin-top:12px';
  const button=document.createElement('button');button.type='button';button.className='btn btn-primary';button.textContent='加入購物車';
  button.onclick=async()=>{button.disabled=true;try{catalog=(await api('catalog')).items||[];add(String(item.id));button.textContent='已加入購物車';}catch(e){button.textContent=e.message||'無法加入購物車，請稍後再試';}finally{button.disabled=false;}};
  const link=document.createElement('a');link.href='./shop.html';link.className='btn btn-ghost';link.textContent='查看購物車';wrap.append(button,link);host.after(wrap);
 }
 window.DKShopUI={product};if(!el('shopForm'))return;
 function trackingUrl(row=tracking){const url=new URL('./shop.html',location.href);url.hash=new URLSearchParams({order:row.id,key:row.token}).toString();return url.href;}
 function saveTracking(row){
  tracking={id:row.id,token:row.token,order_no:row.order_no||'網站訂購'};
  records=[tracking,...records.filter(x=>x.id!==tracking.id)].slice(0,20);
  try{localStorage.setItem(HISTORY,JSON.stringify(records));}catch(_){note('此裝置無法保存查單紀錄，請務必複製查單連結。');}
  try{sessionStorage.setItem('dk_shop_request_v1',JSON.stringify(tracking));}catch(_){}
  history.replaceState(null,'',trackingUrl());renderHistory();
 }
 function renderHistory(){
  el('shopHistory').hidden=!records.length;
  el('shopHistorySelect').innerHTML=records.map((r,i)=>'<option value="'+i+'" '+(r.id===tracking?.id?'selected':'')+'>'+esc(r.order_no||'網站訂購')+'</option>').join('');
 }
 async function refreshStatus(){
  if(!tracking)return;const target=tracking;el('shopTracking').hidden=false;el('shopOrderStatus').textContent='正在查詢進度…';
  try{
   const row=await api('status',{id:target.id,token:target.token});if(tracking!==target)return;
   const labels={awaiting_confirmation:'店家確認供貨中，請勿先匯款',awaiting_payment:row.payment==='store'?'已確認供貨，請聯絡預約到店付款':'已確認供貨，請依店家說明轉帳',payment_review:'已回報轉帳，待店家核實入帳',paid:'店家已確認收款，等待交付',fulfilled:'已完成交付',cancelled:'本次訂購已取消',test_paid:'測試單，無實際交易'};
   el('shopOrderStatus').textContent=row.order_no+'｜'+(labels[row.status]||'待店家確認');
   el('shopOrderDetails').innerHTML=(row.items||[]).map(x=>'<p>'+esc(x.name)+' × '+esc(x.qty)+'｜'+money(x.unit_price)+'</p>').join('')+'<strong>商品 '+money(row.subtotal)+(row.shipping_fee!=null?'＋運費 '+money(row.shipping_fee)+'＝'+money(row.subtotal+row.shipping_fee):'；運費待店家確認')+'</strong>';
   el('shopOrderMessage').textContent=row.customer_message||'請等待店家確認供貨。你也可以加入官方 LINE，提供本頁單號詢問進度。';
   el('shopDeadline').textContent=row.status==='awaiting_payment'&&row.payment==='transfer'&&row.hold_until?'轉帳及回報期限：'+new Date(row.hold_until).toLocaleString('zh-TW')+'。逾時未回報將取消保留；如已匯款請立即聯絡店家。':'';
   el('shopTransferForm').hidden=!(row.status==='awaiting_payment'&&row.payment==='transfer');
   el('shopTrackingLink').value=trackingUrl();
  }catch(e){el('shopOrderStatus').textContent=e.message;el('shopTransferForm').hidden=true;}
 }
 async function submit(event){
  event.preventDefault();if(busy||!service?.enabled)return;
  try{
   const form=el('shopForm'),customer=core.validateCustomer(Object.fromEntries(new FormData(form))),cart=read();
   if(!form.elements.consent.checked)throw Error('請先確認訂購與資料使用說明');
   const q=core.quote(cart,catalog);if(!cart.length||q.errors.length)throw Error(q.errors.join('；')||'購物車還沒有商品');
   const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({customer,cart})))),x=>x.toString(16).padStart(2,'0')).join('');
   let pending;try{pending=JSON.parse(sessionStorage.getItem(PENDING)||'null');}catch(_){}
   if(!pending||pending.fingerprint!==fingerprint)pending={fingerprint,cart,key:crypto.randomUUID(),token:Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('')};
   sessionStorage.setItem(PENDING,JSON.stringify(pending));busy=true;render();note('正在送出，請勿重複操作…');
   const row=await api('create',{customer,cart,key:pending.key,token:pending.token,challenge:service.challenge,consent:true,website:form.elements.website.value});
   saveTracking({id:row.id,token:pending.token,order_no:row.order_no});
   try{localStorage.removeItem(KEY);sessionStorage.removeItem(PENDING);}catch(_){}
   form.reset();updateDelivery();note('已收到訂購需求，尚未付款。請保存查單連結，等待店家確認供貨及付款／取貨說明。');
   await refreshStatus();el('shopTracking').scrollIntoView?.({behavior:'smooth',block:'start'});
  }catch(e){note(e.message||'送出失敗，購物車已保留。');if(String(e.message).includes('驗證')){try{service=await api('config');note('驗證已更新，資料與購物車都保留，請稍候再按一次送出。');}catch(_){}}}
  finally{busy=false;render();}
 }
 function updateDelivery(){const form=el('shopForm'),delivery=form.elements.fulfillment.value==='delivery';el('shopAddressField').hidden=!delivery;form.elements.address.required=delivery;const option=form.elements.payment.querySelector('[value="store"]');option.disabled=delivery;if(delivery&&form.elements.payment.value==='store')form.elements.payment.value='transfer';}
 async function init(){
  try{records=JSON.parse(localStorage.getItem(HISTORY)||'[]').filter(validRecord).slice(0,20);}catch(_){records=[];}
  const params=new URLSearchParams(location.hash.slice(1)),fromLink={id:params.get('order'),token:params.get('key')};
  if(validRecord(fromLink))tracking=fromLink;
  else{try{const old=JSON.parse(sessionStorage.getItem('dk_shop_request_v1')||'null');tracking=validRecord(old)?old:records[0]||null;}catch(_){tracking=records[0]||null;}}
  renderHistory();
  document.addEventListener('click',event=>{const a=event.target.closest('[data-shop-add]'),r=event.target.closest('[data-shop-remove]');try{if(a){add(a.dataset.shopAdd);note('已加入購物車');}if(r)write(read().filter(x=>x.id!==r.dataset.shopRemove));}catch(e){note(e.message||'無法更新購物車，請確認瀏覽器儲存設定');}});
  document.addEventListener('change',event=>{if(event.target.matches('[data-shop-qty]')){const rows=read(),line=rows.find(x=>x.id===event.target.dataset.shopQty),qty=Number(event.target.value);if(!line||!Number.isInteger(qty)||qty<1||qty>99){render();return;}line.qty=qty;try{write(rows);}catch(_){note('無法更新購物車');}}});
  el('shopForm').onsubmit=submit;el('shopForm').elements.fulfillment.onchange=updateDelivery;updateDelivery();
  el('shopReload').onclick=reload;el('shopRefreshStatus').onclick=refreshStatus;
  el('shopHistorySelect').onchange=()=>{tracking=records[Number(el('shopHistorySelect').value)];refreshStatus();};
  el('shopCopyTracking').onclick=async()=>{try{await navigator.clipboard.writeText(trackingUrl());el('shopCopyMessage').textContent='查單連結已複製，請妥善保存，勿公開分享。';}catch(_){el('shopTrackingLink').select();el('shopCopyMessage').textContent='請複製上方完整查單連結並妥善保存。';}};
  el('shopTransferForm').onsubmit=async event=>{event.preventDefault();if(busy||!tracking)return;const last5=el('shopLast5').value.trim();if(!/^\d{5}$/.test(last5)){el('shopTransferMessage').textContent='請填轉出帳號末五碼';return;}if(!confirm('確認你已完成轉帳？這是回報，不代表店家已確認收款。'))return;busy=true;el('shopReportTransfer').disabled=true;try{await api('report_transfer',{id:tracking.id,token:tracking.token,last5});el('shopTransferMessage').textContent='已回報，請等待店家核實入帳。';await refreshStatus();}catch(e){el('shopTransferMessage').textContent=e.message;}finally{busy=false;el('shopReportTransfer').disabled=false;}};
  try{service=await api('config');}catch(_){service={enabled:false};}
  el('shopBanner').textContent=service.enabled?'已開放訂購需求：店家確認供貨及運費後，再安排銀行轉帳或到店付款。':'購物服務目前暫停接單，請透過官方 LINE 聯絡。';el('shopSubmit').textContent=service.enabled?'送出訂購需求':'目前暫停接單';
  await reload();
  try{
   const pending=JSON.parse(sessionStorage.getItem(PENDING)||'null');
   if(pending?.key&&pending?.token){const row=await api('recover',{key:pending.key,token:pending.token});if(row.id){saveTracking({id:row.id,token:pending.token,order_no:row.order_no});if(pending.cart&&JSON.stringify(pending.cart)===JSON.stringify(read()))localStorage.removeItem(KEY);sessionStorage.removeItem(PENDING);note('已找回前次送出的訂購，請保存下方查單連結，勿重複下單。');render();}}
  }catch(_){}
  if(tracking)await refreshStatus();
 }
 init();
})();
